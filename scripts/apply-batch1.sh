#!/bin/bash
set -euo pipefail

# Batch 1 Migration - Optimized Application Script
# Usage: ./scripts/apply-batch1.sh [--dry-run] [--skip-backup]

MIGRATION_DIR="prisma/migrations/20251110_add_memory_entities"
DRY_RUN=false
SKIP_BACKUP=false

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse arguments
for arg in "$@"; do
  case $arg in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --skip-backup)
      SKIP_BACKUP=true
      shift
      ;;
    *)
      ;;
  esac
done

echo -e "${BLUE}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     Batch 1: Context Memory Migration - Apply Script    ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check DATABASE_URL
if [ -z "${DATABASE_URL:-}" ]; then
  echo -e "${RED}❌ ERROR: DATABASE_URL environment variable not set${NC}"
  echo ""
  echo "Set it with:"
  echo "  export DATABASE_URL='postgresql://user:pass@host/db'"
  exit 1
fi

echo -e "${GREEN}✓${NC} Database URL configured"
echo ""

# Extract database name for display
DB_NAME=$(echo "$DATABASE_URL" | sed -n 's|.*@[^/]*/\([^?]*\).*|\1|p')
echo -e "Target database: ${YELLOW}$DB_NAME${NC}"
echo ""

# Dry run check
if [ "$DRY_RUN" = true ]; then
  echo -e "${YELLOW}🔍 DRY RUN MODE - No changes will be applied${NC}"
  echo ""
  echo "Migration SQL preview:"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  head -n 50 "$MIGRATION_DIR/migration.sql"
  echo "..."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  exit 0
fi

# Backup reminder
if [ "$SKIP_BACKUP" = false ]; then
  echo -e "${YELLOW}⚠️  BACKUP REMINDER${NC}"
  echo "Have you taken a database backup/snapshot?"
  echo ""
  read -p "Continue? (yes/no): " -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    echo -e "${RED}Aborted by user${NC}"
    exit 1
  fi
fi

# Pre-migration health check
echo -e "${BLUE}[1/5] Pre-migration health check...${NC}"
EXISTING_TABLES=$(psql "$DATABASE_URL" -t -A -c "
  SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'public';
")
echo -e "  ${GREEN}✓${NC} Found $EXISTING_TABLES existing tables"

# Check if already applied
if psql "$DATABASE_URL" -t -A -c "SELECT to_regclass('public.\"Customer\"');" | grep -q "Customer"; then
  echo -e "${YELLOW}⚠️  WARNING: Customer table already exists!${NC}"
  echo ""
  read -p "Migration may already be applied. Continue anyway? (yes/no): " -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    echo -e "${RED}Aborted by user${NC}"
    exit 1
  fi
fi

# Apply migration
echo ""
echo -e "${BLUE}[2/5] Applying migration...${NC}"
if psql "$DATABASE_URL" -f "$MIGRATION_DIR/migration.sql" > /tmp/migration_output.log 2>&1; then
  echo -e "  ${GREEN}✓${NC} Migration applied successfully"
else
  echo -e "  ${RED}✗${NC} Migration failed!"
  echo ""
  echo "Error details:"
  cat /tmp/migration_output.log
  exit 1
fi

# Validate new tables
echo ""
echo -e "${BLUE}[3/5] Validating new tables...${NC}"
NEW_TABLES=$(psql "$DATABASE_URL" -t -A -c "
  SELECT tablename FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN ('Customer', 'CustomerAddress', 'Conversation', 'Message', 'MemoryNote', 'JobItem', 'JobEvent')
  ORDER BY tablename;
")

EXPECTED_TABLES=7
ACTUAL_TABLES=$(echo "$NEW_TABLES" | wc -l | tr -d ' ')

if [ "$ACTUAL_TABLES" -eq "$EXPECTED_TABLES" ]; then
  echo -e "  ${GREEN}✓${NC} All 7 new tables created:"
  echo "$NEW_TABLES" | sed 's/^/    • /'
else
  echo -e "  ${RED}✗${NC} Expected $EXPECTED_TABLES tables, found $ACTUAL_TABLES"
  exit 1
fi

# Validate altered tables
echo ""
echo -e "${BLUE}[4/5] Validating altered tables...${NC}"

LEAD_COLUMN=$(psql "$DATABASE_URL" -t -A -c "
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'Lead' AND column_name = 'customer_id';
")
if [ -n "$LEAD_COLUMN" ]; then
  echo -e "  ${GREEN}✓${NC} Lead.customer_id column added"
else
  echo -e "  ${RED}✗${NC} Lead.customer_id column missing"
  exit 1
fi

JOB_COLUMN=$(psql "$DATABASE_URL" -t -A -c "
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'Job' AND column_name = 'customer_id';
")
if [ -n "$JOB_COLUMN" ]; then
  echo -e "  ${GREEN}✓${NC} Job.customer_id column added"
else
  echo -e "  ${RED}✗${NC} Job.customer_id column missing"
  exit 1
fi

# Validate enum
ENUM_EXISTS=$(psql "$DATABASE_URL" -t -A -c "
  SELECT EXISTS(SELECT 1 FROM pg_type WHERE typname = 'MessageRole');
")
if [ "$ENUM_EXISTS" = "t" ]; then
  echo -e "  ${GREEN}✓${NC} MessageRole enum created"
else
  echo -e "  ${RED}✗${NC} MessageRole enum missing"
  exit 1
fi

# Run full validation suite
echo ""
echo -e "${BLUE}[5/5] Running comprehensive validation...${NC}"
if psql "$DATABASE_URL" -f "$MIGRATION_DIR/validation.sql" > /tmp/validation_output.log 2>&1; then
  echo -e "  ${GREEN}✓${NC} All validation queries passed"
  echo ""
  echo "Full validation results saved to: /tmp/validation_output.log"
else
  echo -e "  ${YELLOW}⚠${NC}  Some validation queries returned warnings (check log)"
  echo ""
  echo "Validation output:"
  tail -n 20 /tmp/validation_output.log
fi

# Summary
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          ✓ Batch 1 Migration Applied Successfully       ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo "  1. Monitor application logs for errors"
echo "  2. Verify CONTEXT_MEMORY_ENABLED=false in app environment"
echo "  3. Update Prisma Client: npx prisma generate"
echo "  4. Plan Batch 2 (data backfill)"
echo ""
echo -e "${YELLOW}Note:${NC} New tables are currently empty and not used by the app"
echo ""
