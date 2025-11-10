# Batch 2 — Full-Text Search Index for Message Recall

## Objective
Enable fast keyword-based recall over message history using PostgreSQL's Full-Text Search (FTS) capabilities.

## Status
- **Created**: 2025-11-10
- **Applied**: ❌ (Pending)
- **Validated**: ❌ (Pending)

## Changes

### Indexes Added
1. **Message_content_fts_idx** (GIN)
   - Type: GIN (Generalized Inverted Index)
   - Column: `to_tsvector('english', COALESCE(content, ''))`
   - Purpose: Fast full-text search with stemming, stop words, and ranking
   - Dictionary: English (stemming: "removal" matches "remove", "removing")

2. **Message_role_idx** (BTREE)
   - Type: BTREE
   - Column: `role`
   - Purpose: Filter by message role (user, assistant, system, tool)
   - Enables combined queries: "Find user messages about junk"

## Why GIN Index?

**GIN (Generalized Inverted Index)** is optimal for full-text search because:
- Stores inverted index: word → list of rows containing that word
- Supports `@@` (matches) operator efficiently
- Handles stemming, ranking, and phrase search
- Typical speedup: 10-1000x vs `ILIKE '%keyword%'`

**Trade-offs**:
- Larger index size (~2-3x the text column size)
- Slightly slower writes (maintains inverted index)
- Worth it for read-heavy search workloads

## Usage Examples

### Basic Search
```sql
SELECT * FROM "Message"
WHERE to_tsvector('english', COALESCE(content, ''))
      @@ plainto_tsquery('english', 'junk removal');
```

### Search with Role Filter
```sql
SELECT * FROM "Message"
WHERE role = 'user'
  AND to_tsvector('english', COALESCE(content, ''))
      @@ plainto_tsquery('english', 'quote');
```

### Ranked Search (Most Relevant First)
```sql
SELECT
  id,
  role,
  content,
  ts_rank(
    to_tsvector('english', COALESCE(content, '')),
    plainto_tsquery('english', 'junk removal')
  ) as relevance
FROM "Message"
WHERE to_tsvector('english', COALESCE(content, ''))
      @@ plainto_tsquery('english', 'junk removal')
ORDER BY relevance DESC;
```

### Highlighted Results
```sql
SELECT
  id,
  ts_headline(
    'english',
    content,
    plainto_tsquery('english', 'quote'),
    'StartSel=<mark>, StopSel=</mark>'
  ) as highlighted_content
FROM "Message"
WHERE to_tsvector('english', COALESCE(content, ''))
      @@ plainto_tsquery('english', 'quote');
```

### Phrase Search
```sql
SELECT * FROM "Message"
WHERE to_tsvector('english', COALESCE(content, ''))
      @@ phraseto_tsquery('english', 'need help removing');
```

## Performance Impact

### Query Performance
- **Without FTS**: Sequential scan, O(n) per search
- **With FTS**: Index scan, O(log n + matching rows)
- **Expected speedup**: 10-1000x on large datasets

### Storage Impact
- **GIN index size**: ~200-300% of text column size
- **Empty table**: <100KB
- **1M messages (avg 200 chars)**: ~400-600MB index size

### Write Performance
- **Index maintenance**: ~10-30% slower inserts
- **Acceptable**: Message writes are infrequent vs searches

## Migration Files
- `migration.sql` - Creates GIN + BTREE indexes
- `validation.sql` - EXPLAIN plans and FTS tests
- `rollback.sql` - Drops indexes

## Pre-Migration Checklist
- [x] Batch 1 applied (Message table exists)
- [ ] Verify Message table is empty or has test data
- [ ] Review index size estimates
- [ ] Confirm read-heavy workload justifies GIN overhead

## Apply Migration

### Using Script (Recommended)
```bash
export DATABASE_URL="postgresql://..."
./scripts/apply-batch2.sh
```

### Direct SQL
```bash
psql "$DATABASE_URL" -f prisma/migrations/20251110_add_message_fts_index/migration.sql
```

## Validation

Run validation queries:
```bash
psql "$DATABASE_URL" -f prisma/migrations/20251110_add_message_fts_index/validation.sql
```

Expected output:
- ✓ Both indexes exist
- ✓ EXPLAIN plans show index usage
- ✓ FTS search test passes

## Rollback

```bash
psql "$DATABASE_URL" -f prisma/migrations/20251110_add_message_fts_index/rollback.sql
```

**Impact**: Removes FTS capability, search queries will be slow.

## Application Integration

### TypeScript/Prisma Example
```typescript
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Raw SQL FTS query
const results = await prisma.$queryRaw`
  SELECT id, role, content,
    ts_rank(
      to_tsvector('english', COALESCE(content, '')),
      plainto_tsquery('english', ${searchTerm})
    ) as rank
  FROM "Message"
  WHERE to_tsvector('english', COALESCE(content, ''))
        @@ plainto_tsquery('english', ${searchTerm})
  ORDER BY rank DESC
  LIMIT 20
`;
```

### Create Helper Function (Optional)
```sql
-- Add to a future migration if desired
CREATE OR REPLACE FUNCTION search_messages(query_text TEXT)
RETURNS TABLE (
  id UUID,
  role "MessageRole",
  content TEXT,
  rank REAL,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.role,
    m.content,
    ts_rank(
      to_tsvector('english', COALESCE(m.content, '')),
      plainto_tsquery('english', query_text)
    )::REAL as rank,
    m.created_at
  FROM "Message" m
  WHERE to_tsvector('english', COALESCE(m.content, ''))
        @@ plainto_tsquery('english', query_text)
  ORDER BY rank DESC;
END;
$$ LANGUAGE plpgsql STABLE;
```

## Next Steps (Batch 3)

After Batch 2:
- Batch 3: Data backfill (migrate existing conversations)
- Add message history to agent context
- Implement semantic recall with vector embeddings (future)

## Performance Tips

1. **Use plainto_tsquery** for user input (handles special chars)
2. **Use to_tsquery** for advanced queries (AND, OR, NOT)
3. **Add conversation_id filter** to narrow search scope
4. **Use ts_rank** to sort by relevance
5. **Consider websearch_to_tsquery** for Google-like queries

## Dictionary Options

Current: `'english'`

Other options:
- `'simple'` - No stemming, case-insensitive
- `'spanish'`, `'french'`, etc. - Language-specific

Change by updating migration:
```sql
to_tsvector('simple', COALESCE(content, ''))
```

## Maintenance

### Reindex (if needed)
```sql
REINDEX INDEX "Message_content_fts_idx";
```

### Monitor Index Usage
```sql
SELECT
  schemaname,
  tablename,
  indexname,
  idx_scan as index_scans,
  idx_tup_read as tuples_read
FROM pg_stat_user_indexes
WHERE indexname = 'Message_content_fts_idx';
```

## References
- [PostgreSQL Full-Text Search](https://www.postgresql.org/docs/current/textsearch.html)
- [GIN Indexes](https://www.postgresql.org/docs/current/gin.html)
- [Text Search Functions](https://www.postgresql.org/docs/current/functions-textsearch.html)
