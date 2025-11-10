# Batch 8 — Performance and Maintenance

## Objective
Post-backfill optimization and future-proofing for long-term database health and performance.

## Status
- **Created**: 2025-11-10
- **Applied**: ❌ (Pending)
- **Type**: Maintenance (no schema changes)

---

## Overview

This batch performs **post-migration optimization** after large data backfills in Batches 3 and 4. It:
1. Runs VACUUM ANALYZE to update statistics and reclaim space
2. Rebuilds indexes for optimal performance
3. Tunes autovacuum for high-traffic tables
4. Verifies database health metrics
5. Documents ongoing maintenance procedures

**Key Feature**: Non-destructive maintenance (no schema or data changes)

---

## Actions Performed

### 1. VACUUM ANALYZE (Reclaim Space and Update Statistics)

Runs VACUUM ANALYZE on tables that had large inserts:

```sql
VACUUM (ANALYZE, VERBOSE) "Message";      -- 216 rows inserted
VACUUM (ANALYZE, VERBOSE) "Conversation"; -- 3 rows inserted
VACUUM (ANALYZE, VERBOSE) "Customer";     -- 3 rows inserted
VACUUM (ANALYZE, VERBOSE) "Lead";         -- Updated with customer_id
VACUUM (ANALYZE, VERBOSE) "Job";          -- Updated with customer_id
```

**Purpose**:
- Reclaim space from dead rows
- Update table statistics for query planner
- Prevent table bloat

---

### 2. ANALYZE (Update Query Planner Statistics)

Updates statistics for all context memory tables:

```sql
ANALYZE "Customer";
ANALYZE "CustomerAddress";
ANALYZE "Conversation";
ANALYZE "Message";
ANALYZE "MemoryNote";
ANALYZE "JobItem";
ANALYZE "JobEvent";
```

**Purpose**: Ensure query planner has accurate row counts and data distribution

---

### 3. REINDEX (Rebuild Indexes)

Rebuilds critical indexes for optimal performance:

```sql
REINDEX INDEX CONCURRENTLY "Message_content_fts_idx";
REINDEX INDEX CONCURRENTLY "Message_conversation_id_created_at_idx";
REINDEX INDEX CONCURRENTLY "Conversation_customer_id_started_at_idx";
REINDEX INDEX CONCURRENTLY "Conversation_lead_open_unique";
```

**Purpose**:
- Defragment indexes
- Improve index scan performance
- Reclaim index bloat

**Note**: `CONCURRENTLY` allows queries to continue during reindex

---

### 4. Autovacuum Tuning

Configures aggressive autovacuum for high-traffic tables:

**Message Table** (will grow quickly):
```sql
ALTER TABLE "Message" SET (
  autovacuum_vacuum_scale_factor = 0.05,  -- Vacuum when 5% of rows updated
  autovacuum_analyze_scale_factor = 0.02, -- Analyze when 2% updated
  autovacuum_vacuum_cost_delay = 10       -- Faster autovacuum
);
```

**Conversation Table**:
```sql
ALTER TABLE "Conversation" SET (
  autovacuum_vacuum_scale_factor = 0.1,   -- Vacuum when 10% updated
  autovacuum_analyze_scale_factor = 0.05  -- Analyze when 5% updated
);
```

**Impact**: Autovacuum runs more frequently, preventing bloat

---

## Usage

### Run Maintenance

```bash
export DATABASE_URL="postgresql://..."

# Run full maintenance
psql "$DATABASE_URL" \
  -f prisma/migrations/20251110_performance_maintenance/maintenance.sql
```

### Expected Duration

| Operation | Time | Blocking |
|-----------|------|----------|
| VACUUM ANALYZE (5 tables) | ~5-10s | No (reads allowed) |
| ANALYZE (7 tables) | ~1-2s | No |
| REINDEX CONCURRENTLY (4 indexes) | ~10-30s | No (concurrent) |
| ALTER TABLE (autovacuum) | <1s | No |
| **Total** | **~20-45s** | **No downtime** |

---

### Validate Results

```bash
psql "$DATABASE_URL" \
  -f prisma/migrations/20251110_performance_maintenance/validation.sql
```

---

## Validation Tests

### Test 1: Verify Vacuum/Analyze Completed

Checks that tables were recently vacuumed and analyzed:

```
table_name   | vacuum_status          | analyze_status
Message      | ✓ Recently vacuumed    | ✓ Recently analyzed
Conversation | ✓ Recently vacuumed    | ✓ Recently analyzed
Customer     | ✓ Recently vacuumed    | ✓ Recently analyzed
```

---

### Test 2: Dead Tuple Analysis

Verifies low dead row ratio after vacuum:

```
table_name   | live_rows | dead_rows | dead_ratio_pct | health_status
Message      | 216       | 0         | 0.00           | ✓ EXCELLENT: No dead rows
Conversation | 3         | 0         | 0.00           | ✓ EXCELLENT: No dead rows
```

**Thresholds**:
- <5%: ✓ GOOD
- 5-10%: ○ OK
- >10%: ⚠ WARNING (needs vacuum)

---

### Test 3: Index Usage Statistics

Shows which indexes are being used:

```
index_name                              | scans | tuples_read | usage_status
Message_content_fts_idx                 | 5     | 25          | ✓ USED
Message_conversation_id_created_at_idx  | 0     | 0           | ○ NOT YET USED
```

**Note**: Low usage is normal initially - will increase with production traffic

---

### Test 4: Query Performance Test

Runs EXPLAIN ANALYZE on critical queries:

```sql
-- Should show: Index Scan using Message_conversation_id_created_at_idx
SELECT * FROM "Message"
WHERE conversation_id = '...'
ORDER BY created_at DESC
LIMIT 20;
```

**Expected**: Query uses appropriate index, execution time <10ms

---

### Test 5: Autovacuum Configuration

Verifies custom autovacuum settings applied:

```
table_name   | custom_settings                          | config_status
Message      | {autovacuum_vacuum_scale_factor=0.05...} | ✓ Custom configured
Conversation | {autovacuum_vacuum_scale_factor=0.1...}  | ✓ Custom configured
```

---

### Test 6: Table Bloat Check

Estimates table and index bloat:

```
tablename    | total_size | table_size | index_size | size_category
Message      | 128 kB     | 80 kB      | 48 kB      | ✓ SMALL: <1MB
Conversation | 16 kB      | 8 kB       | 8 kB       | ✓ SMALL: <1MB
```

---

### Test 7: Cache Performance

Measures cache hit ratio:

```
table_name | disk_reads | cache_hits | cache_hit_ratio_pct | performance_status
Message    | 10         | 990        | 99.00               | ✓ EXCELLENT: >99% cache hits
```

**Thresholds**:
- >99%: ✓ EXCELLENT
- 95-99%: ✓ GOOD
- 90-95%: ○ OK
- <90%: ⚠ WARNING

---

### Test 8: Storage Summary

Overall database size report:

```
total_database_size | context_memory_size | total_messages
50 MB               | 500 kB              | 216
```

---

## Ongoing Maintenance Schedule

### Daily (Automatic via Autovacuum)
- ✅ Autovacuum runs automatically on Message and Conversation
- ✅ Statistics updated as tables change
- ✅ No manual intervention needed

### Weekly (Recommended)
```bash
# Run quick health check
psql "$DATABASE_URL" -c "
  SELECT
    relname,
    n_live_tup,
    n_dead_tup,
    ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup, 0), 2) as dead_pct
  FROM pg_stat_user_tables
  WHERE relname IN ('Message', 'Conversation', 'Customer')
  ORDER BY dead_pct DESC NULLS LAST;
"
```

**Expected**: dead_pct < 5% for all tables

---

### Monthly (Recommended)
```bash
# Full maintenance run
psql "$DATABASE_URL" \
  -f prisma/migrations/20251110_performance_maintenance/maintenance.sql
```

**When to run manually**:
- After large data imports
- If query performance degrades
- Dead row ratio >10%
- Index bloat suspected

---

### Quarterly (Recommended)
```bash
# Full validation and health check
psql "$DATABASE_URL" \
  -f prisma/migrations/20251110_performance_maintenance/validation.sql
```

**Review**:
- Index usage patterns
- Table growth trends
- Cache hit ratios
- Storage requirements

---

## Monitoring Queries

### Quick Health Check

```sql
-- One-liner health status
SELECT
  'Message' as table,
  n_live_tup as rows,
  ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup, 0), 2) as dead_pct,
  last_autovacuum,
  last_autoanalyze
FROM pg_stat_user_tables
WHERE relname = 'Message';
```

---

### Index Usage Report

```sql
-- Find unused indexes
SELECT
  schemaname || '.' || relname as table,
  indexrelname as index,
  idx_scan as scans,
  pg_size_pretty(pg_relation_size(indexrelid)) as size
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
  AND idx_scan = 0
  AND indexrelname NOT LIKE '%_pkey'
ORDER BY pg_relation_size(indexrelid) DESC;
```

---

### Bloat Detection

```sql
-- Estimate table bloat
SELECT
  relname,
  pg_size_pretty(pg_total_relation_size(relid)) as total_size,
  n_dead_tup as dead_rows,
  ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup, 0), 2) as est_bloat_pct
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY n_dead_tup DESC
LIMIT 10;
```

---

### Slow Query Detection

```sql
-- Find slow queries (requires pg_stat_statements extension)
SELECT
  query,
  calls,
  ROUND(total_exec_time::numeric, 2) as total_ms,
  ROUND(mean_exec_time::numeric, 2) as avg_ms,
  ROUND(max_exec_time::numeric, 2) as max_ms
FROM pg_stat_statements
WHERE query LIKE '%Message%' OR query LIKE '%Conversation%'
ORDER BY mean_exec_time DESC
LIMIT 10;
```

---

## Autovacuum Explained

### Default Behavior

PostgreSQL autovacuum runs when:
```
threshold = autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor * reltuples
```

**Default settings**:
- `autovacuum_vacuum_threshold`: 50 rows
- `autovacuum_vacuum_scale_factor`: 0.2 (20% of table)

**Example**: Table with 1000 rows needs 50 + (0.2 * 1000) = 250 updates before autovacuum

---

### Batch 8 Tuning

**Message Table** (high traffic expected):
- Threshold: 50 + (0.05 * rows) = autovacuum at 5% updated
- **Example**: 1000 rows → autovacuum after just 100 updates (vs 250 default)

**Conversation Table** (moderate traffic):
- Threshold: 50 + (0.1 * rows) = autovacuum at 10% updated
- **Example**: 100 rows → autovacuum after 60 updates (vs 70 default)

**Benefit**: Prevents bloat before it becomes a problem

---

## Performance Improvements

### Before Batch 8
- Table statistics may be outdated
- Dead rows accumulating
- Indexes potentially fragmented
- Default autovacuum (may be too slow)

### After Batch 8
- ✅ Fresh statistics for query planner
- ✅ Dead rows reclaimed (0% bloat)
- ✅ Indexes rebuilt and defragmented
- ✅ Aggressive autovacuum (5-10% thresholds)
- ✅ Query performance optimized

---

## When to Run This Batch

### Required Scenarios
- ✅ After Batch 4 (large message backfill)
- ✅ After Batch 3 (customer updates)
- ✅ After any bulk data import
- ✅ Before production launch

### Optional Scenarios
- Monthly maintenance schedule
- After high-traffic periods
- When query performance degrades
- If monitoring shows high dead row ratio

---

## Rollback

**Not applicable** - This batch only performs maintenance:
- No schema changes
- No data modifications
- No irreversible actions

**To "undo" autovacuum tuning**:
```sql
ALTER TABLE "Message" RESET (
  autovacuum_vacuum_scale_factor,
  autovacuum_analyze_scale_factor,
  autovacuum_vacuum_cost_delay
);
```

---

## Files

```
prisma/migrations/20251110_performance_maintenance/
├── maintenance.sql    # Main maintenance script (7 steps)
├── validation.sql     # Health check and validation (8 tests)
└── README.md          # This file
```

**Note**: No `migration.sql` - this is a maintenance batch, not a schema migration

---

## Common Issues

### Issue: VACUUM Taking Too Long

**Symptom**: VACUUM runs for minutes on small tables

**Cause**: Table or index bloat, or concurrent write activity

**Fix**:
```sql
-- Check for bloat
SELECT pg_size_pretty(pg_total_relation_size('Message'));

-- If very large, consider VACUUM FULL (requires exclusive lock)
VACUUM FULL "Message";  -- CAUTION: Blocks all access during vacuum
```

---

### Issue: Autovacuum Not Running

**Symptom**: Dead row ratio keeps increasing

**Cause**: Autovacuum disabled or thresholds too high

**Check**:
```sql
SHOW autovacuum;  -- Should be 'on'

SELECT * FROM pg_settings WHERE name LIKE 'autovacuum%';
```

**Fix**: Ensure autovacuum is enabled globally

---

### Issue: Low Cache Hit Ratio

**Symptom**: <90% cache hits

**Cause**: Database buffer pool too small, or cold cache

**Check**:
```sql
SHOW shared_buffers;  -- Should be 25% of RAM ideally
```

**Fix**: Increase shared_buffers in postgresql.conf (requires restart)

---

### Issue: Index Not Being Used

**Symptom**: Sequential scans instead of index scans

**Cause**: Outdated statistics or index not suitable for query

**Fix**:
```sql
-- Update statistics
ANALYZE "Message";

-- Check query plan
EXPLAIN SELECT * FROM "Message" WHERE conversation_id = '...';

-- If still not using index, rebuild it
REINDEX INDEX CONCURRENTLY "Message_conversation_id_created_at_idx";
```

---

## Best Practices

### 1. Monitor Regularly
- Set up weekly health checks
- Track table growth trends
- Watch autovacuum activity

### 2. Tune as Needed
- Adjust autovacuum thresholds based on traffic
- Add indexes for new query patterns
- Remove unused indexes

### 3. Schedule Maintenance
- Monthly VACUUM ANALYZE
- Quarterly full validation
- Annual REINDEX (if needed)

### 4. Watch for Bloat
- Dead row ratio should stay <5%
- Index size should grow proportionally with table
- Run VACUUM if bloat >10%

---

## Summary

**Batch 8** optimizes database performance by:
- Running VACUUM ANALYZE on all key tables
- Rebuilding critical indexes
- Tuning autovacuum for high-traffic tables
- Verifying database health metrics
- Documenting ongoing maintenance procedures

**Risk**: None (read-heavy maintenance, no schema changes)
**Benefit**: High (optimized query performance, bloat prevention)
**Duration**: ~20-45 seconds (non-blocking)

**Prerequisites**:
- ✅ Batches 1-7 completed
- ✅ Large backfills finished (Batches 3-4)

---

**Ready to run? This ensures optimal database performance!**
