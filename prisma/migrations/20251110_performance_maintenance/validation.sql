-- ═══════════════════════════════════════════════════════════════
-- Batch 8 Validation: Performance and Health Metrics
-- Verifies maintenance completed and database is optimized
-- ═══════════════════════════════════════════════════════════════

\echo '=== Batch 8 Validation: Performance Metrics ==='
\echo ''

-- ═══════════════════════════════════════════════════════════════
-- TEST 1: Verify Recent Vacuum/Analyze
-- ═══════════════════════════════════════════════════════════════

\echo '=== TEST 1: Verify Vacuum/Analyze Completed ==='
\echo ''

SELECT
  relname as table_name,
  CASE
    WHEN last_vacuum > NOW() - INTERVAL '1 hour' THEN '✓ Recently vacuumed'
    WHEN last_autovacuum > NOW() - INTERVAL '1 hour' THEN '✓ Auto-vacuumed'
    ELSE '○ Not recently vacuumed'
  END as vacuum_status,
  CASE
    WHEN last_analyze > NOW() - INTERVAL '1 hour' THEN '✓ Recently analyzed'
    WHEN last_autoanalyze > NOW() - INTERVAL '1 hour' THEN '✓ Auto-analyzed'
    ELSE '○ Not recently analyzed'
  END as analyze_status,
  last_vacuum,
  last_analyze
FROM pg_stat_user_tables
WHERE relname IN ('Customer', 'Conversation', 'Message', 'Lead', 'Job')
ORDER BY relname;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- TEST 2: Check Dead Tuple Ratio
-- ═══════════════════════════════════════════════════════════════

\echo '=== TEST 2: Dead Tuple Analysis ==='
\echo ''

SELECT
  relname as table_name,
  n_live_tup as live_rows,
  n_dead_tup as dead_rows,
  ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) as dead_ratio_pct,
  CASE
    WHEN n_dead_tup = 0 THEN '✓ EXCELLENT: No dead rows'
    WHEN ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) < 5 THEN '✓ GOOD: <5% dead rows'
    WHEN ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) < 10 THEN '○ OK: <10% dead rows'
    ELSE '⚠ WARNING: High dead row ratio'
  END as health_status
FROM pg_stat_user_tables
WHERE relname IN ('Customer', 'Conversation', 'Message', 'Lead', 'Job', 'CustomerAddress')
ORDER BY dead_ratio_pct DESC NULLS LAST;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- TEST 3: Index Usage Statistics
-- ═══════════════════════════════════════════════════════════════

\echo '=== TEST 3: Index Usage Verification ==='
\echo ''

SELECT
  schemaname,
  relname as table_name,
  indexrelname as index_name,
  idx_scan as scans,
  idx_tup_read as tuples_read,
  CASE
    WHEN idx_scan > 0 THEN '✓ USED'
    ELSE '○ NOT YET USED'
  END as usage_status,
  pg_size_pretty(pg_relation_size(indexrelid)) as index_size
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
  AND indexrelname IN (
    'Conversation_lead_open_unique',
    'Message_conversation_id_created_at_idx',
    'Conversation_customer_id_started_at_idx',
    'Message_content_fts_idx',
    'Message_role_idx',
    'Customer_phone_idx',
    'Customer_email_idx'
  )
ORDER BY idx_scan DESC;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- TEST 4: Query Performance Sampling
-- ═══════════════════════════════════════════════════════════════

\echo '=== TEST 4: Query Performance Test ==='
\echo ''

-- Test 1: Recent messages query (should use index)
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM "Message"
WHERE conversation_id = (SELECT id FROM "Conversation" LIMIT 1)
ORDER BY created_at DESC
LIMIT 20;

\echo ''

-- Test 2: FTS search query (should use GIN index)
EXPLAIN (ANALYZE, BUFFERS)
SELECT *
FROM "Message"
WHERE to_tsvector('english', content) @@ plainto_tsquery('english', 'sectional')
LIMIT 10;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- TEST 5: Autovacuum Configuration
-- ═══════════════════════════════════════════════════════════════

\echo '=== TEST 5: Autovacuum Settings ==='
\echo ''

SELECT
  relname as table_name,
  reloptions as custom_settings,
  CASE
    WHEN reloptions IS NOT NULL THEN '✓ Custom autovacuum configured'
    ELSE '○ Using default autovacuum settings'
  END as config_status
FROM pg_class
WHERE relname IN ('Message', 'Conversation', 'Customer')
  AND relkind = 'r'
ORDER BY relname;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- TEST 6: Table Bloat Estimation
-- ═══════════════════════════════════════════════════════════════

\echo '=== TEST 6: Table Bloat Check ==='
\echo ''

WITH bloat_data AS (
  SELECT
    schemaname,
    tablename,
    pg_total_relation_size(schemaname||'.'||tablename) as total_bytes,
    pg_relation_size(schemaname||'.'||tablename) as table_bytes,
    (pg_total_relation_size(schemaname||'.'||tablename) - pg_relation_size(schemaname||'.'||tablename)) as index_bytes
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN ('Customer', 'Conversation', 'Message', 'Lead', 'Job')
)
SELECT
  tablename,
  pg_size_pretty(total_bytes) as total_size,
  pg_size_pretty(table_bytes) as table_size,
  pg_size_pretty(index_bytes) as index_size,
  ROUND(100.0 * index_bytes / NULLIF(total_bytes, 0), 2) as index_ratio_pct,
  CASE
    WHEN total_bytes < 1024 * 1024 THEN '✓ SMALL: <1MB'
    WHEN total_bytes < 10 * 1024 * 1024 THEN '✓ MEDIUM: <10MB'
    WHEN total_bytes < 100 * 1024 * 1024 THEN '○ LARGE: <100MB'
    ELSE '⚠ VERY LARGE: >100MB'
  END as size_category
FROM bloat_data
ORDER BY total_bytes DESC;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- TEST 7: Cache Hit Ratio
-- ═══════════════════════════════════════════════════════════════

\echo '=== TEST 7: Cache Performance ==='
\echo ''

SELECT
  relname as table_name,
  heap_blks_read as disk_reads,
  heap_blks_hit as cache_hits,
  CASE
    WHEN (heap_blks_hit + heap_blks_read) = 0 THEN 0
    ELSE ROUND(100.0 * heap_blks_hit / (heap_blks_hit + heap_blks_read), 2)
  END as cache_hit_ratio_pct,
  CASE
    WHEN (heap_blks_hit + heap_blks_read) = 0 THEN '○ No reads yet'
    WHEN ROUND(100.0 * heap_blks_hit / (heap_blks_hit + heap_blks_read), 2) > 99 THEN '✓ EXCELLENT: >99% cache hits'
    WHEN ROUND(100.0 * heap_blks_hit / (heap_blks_hit + heap_blks_read), 2) > 95 THEN '✓ GOOD: >95% cache hits'
    WHEN ROUND(100.0 * heap_blks_hit / (heap_blks_hit + heap_blks_read), 2) > 90 THEN '○ OK: >90% cache hits'
    ELSE '⚠ WARNING: Low cache hit ratio'
  END as performance_status
FROM pg_statio_user_tables
WHERE relname IN ('Customer', 'Conversation', 'Message', 'Lead', 'Job')
ORDER BY cache_hit_ratio_pct DESC NULLS LAST;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- TEST 8: Overall Database Size
-- ═══════════════════════════════════════════════════════════════

\echo '=== TEST 8: Overall Storage Summary ==='
\echo ''

SELECT
  pg_size_pretty(pg_database_size(current_database())) as total_database_size,
  (SELECT pg_size_pretty(SUM(pg_total_relation_size(schemaname||'.'||tablename)))
   FROM pg_tables
   WHERE schemaname = 'public'
     AND tablename IN ('Customer', 'CustomerAddress', 'Conversation', 'Message', 'MemoryNote', 'JobItem', 'JobEvent')
  ) as context_memory_size,
  (SELECT COUNT(*) FROM "Customer") as total_customers,
  (SELECT COUNT(*) FROM "Conversation") as total_conversations,
  (SELECT COUNT(*) FROM "Message") as total_messages;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- VALIDATION SUMMARY
-- ═══════════════════════════════════════════════════════════════

\echo '=== Batch 8 Validation Complete ==='
\echo ''
\echo 'Tests performed:'
\echo '  1. Vacuum/Analyze status verified'
\echo '  2. Dead tuple ratio checked'
\echo '  3. Index usage confirmed'
\echo '  4. Query performance tested'
\echo '  5. Autovacuum configuration verified'
\echo '  6. Table bloat estimated'
\echo '  7. Cache hit ratio analyzed'
\echo '  8. Storage summary generated'
\echo ''
\echo 'Expected results:'
\echo '  - Dead row ratio: <5% (excellent)'
\echo '  - Cache hit ratio: >95% (good)'
\echo '  - Index usage: Varies by production load'
\echo '  - Query performance: Uses indexes'
\echo ''
