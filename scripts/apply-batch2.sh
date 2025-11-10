#!/bin/bash
set -euo pipefail

# Batch 2 Migration - FTS Index Application Script
# Usage: ./scripts/apply-batch2.sh [--dry-run]

MIGRATION_DIR="prisma/migrations/20251110_add_message_fts_index"
DRY_RUN=false

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Parse arguments
for arg in "$@"; do
  case $arg in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    *)
      ;;
  esac
done

echo -e "${BLUE}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║         Batch 2: FTS Index Migration - Apply Script     ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check DATABASE_URL
if [ -z "${DATABASE_URL:-}" ]; then
  echo -e "${RED}❌ ERROR: DATABASE_URL environment variable not set${NC}"
  exit 1
fi

echo -e "${GREEN}✓${NC} Database URL configured"
DB_NAME=$(echo "$DATABASE_URL" | sed -n 's|.*@[^/]*/\([^?]*\).*|\1|p')
echo -e "Target database: ${YELLOW}$DB_NAME${NC}"
echo ""

# Dry run check
if [ "$DRY_RUN" = true ]; then
  echo -e "${YELLOW}🔍 DRY RUN MODE - Preview migration${NC}"
  echo ""
  cat "$MIGRATION_DIR/migration.sql"
  exit 0
fi

# Verify Batch 1 completed
echo -e "${BLUE}[1/5] Pre-flight checks...${NC}"
MESSAGE_TABLE=$(psql "$DATABASE_URL" -t -A -c "SELECT to_regclass('public.\"Message\"');")
if [ -z "$MESSAGE_TABLE" ] || [ "$MESSAGE_TABLE" = "null" ]; then
  echo -e "${RED}❌ ERROR: Message table not found!${NC}"
  echo "Run Batch 1 first: ./scripts/apply-batch1.sh"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Message table exists (Batch 1 complete)"

# Check if already applied
FTS_EXISTS=$(psql "$DATABASE_URL" -t -A -c "
  SELECT COUNT(*) FROM pg_indexes WHERE indexname = 'Message_content_fts_idx';
")
if [ "$FTS_EXISTS" != "0" ]; then
  echo -e "${YELLOW}⚠️  FTS index already exists${NC}"
  read -p "Re-apply migration? (yes/no): " -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    echo "Aborted"
    exit 0
  fi
fi

# Apply migration
echo ""
echo -e "${BLUE}[2/5] Creating FTS indexes...${NC}"
if psql "$DATABASE_URL" -f "$MIGRATION_DIR/migration.sql" > /tmp/batch2_migration.log 2>&1; then
  echo -e "  ${GREEN}✓${NC} Indexes created successfully"
else
  echo -e "  ${RED}✗${NC} Migration failed!"
  cat /tmp/batch2_migration.log
  exit 1
fi

# Validate indexes
echo ""
echo -e "${BLUE}[3/5] Validating indexes...${NC}"

FTS_IDX=$(psql "$DATABASE_URL" -t -A -c "
  SELECT indexname FROM pg_indexes WHERE indexname = 'Message_content_fts_idx';
")
if [ -n "$FTS_IDX" ]; then
  echo -e "  ${GREEN}✓${NC} Message_content_fts_idx created (GIN)"
else
  echo -e "  ${RED}✗${NC} FTS index missing!"
  exit 1
fi

ROLE_IDX=$(psql "$DATABASE_URL" -t -A -c "
  SELECT indexname FROM pg_indexes WHERE indexname = 'Message_role_idx';
")
if [ -n "$ROLE_IDX" ]; then
  echo -e "  ${GREEN}✓${NC} Message_role_idx created (BTREE)"
else
  echo -e "  ${YELLOW}⚠${NC}  Role index missing (optional)"
fi

# Check index size
echo ""
echo -e "${BLUE}[4/5] Index statistics...${NC}"
INDEX_SIZE=$(psql "$DATABASE_URL" -t -A -c "
  SELECT COALESCE(pg_size_pretty(pg_relation_size('\"Message_content_fts_idx\"')), 'N/A');
" 2>/dev/null || echo "N/A")
echo -e "  FTS index size: ${YELLOW}$INDEX_SIZE${NC}"

# Test FTS query
echo ""
echo -e "${BLUE}[5/5] Testing FTS queries...${NC}"
PLAN=$(psql "$DATABASE_URL" -t -A -c "
  EXPLAIN (FORMAT TEXT)
  SELECT * FROM \"Message\"
  WHERE to_tsvector('english', COALESCE(content, ''))
        @@ plainto_tsquery('english', 'test');
" | grep -i "index")

if echo "$PLAN" | grep -q "Message_content_fts_idx"; then
  echo -e "  ${GREEN}✓${NC} FTS index is being used by queries"
else
  echo -e "  ${YELLOW}⚠${NC}  Could not verify index usage (table may be empty)"
fi

# Summary
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         ✓ Batch 2 Migration Applied Successfully        ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}Indexes created:${NC}"
echo "  • Message_content_fts_idx (GIN) - Full-text search"
echo "  • Message_role_idx (BTREE) - Role filtering"
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo "  1. Test FTS queries in your application"
echo "  2. Monitor index usage with pg_stat_user_indexes"
echo "  3. Proceed to Batch 3 (data backfill)"
echo ""
echo -e "${YELLOW}Example FTS query:${NC}"
echo '  SELECT * FROM "Message"'
echo "  WHERE to_tsvector('english', COALESCE(content, ''))"
echo "        @@ plainto_tsquery('english', 'your search term');"
echo ""
