-- ═══════════════════════════════════════════════════════════════
-- Batch 8: Performance and Maintenance
-- Post-backfill optimization and future-proofing
-- ═══════════════════════════════════════════════════════════════

\echo '=== Batch 8: Performance and Maintenance ==='
\echo ''

-- ═══════════════════════════════════════════════════════════════
-- 1. VACUUM ANALYZE: Update Statistics and Reclaim Space
-- ═══════════════════════════════════════════════════════════════

\echo '=== Step 1: VACUUM ANALYZE Tables ==='
\echo ''

-- Message table (216 rows inserted in Batch 4)
VACUUM (ANALYZE, VERBOSE) "Message";
\echo '✓ Message table vacuumed and analyzed'

-- Conversation table (3 rows inserted in Batch 4)
VACUUM (ANALYZE, VERBOSE) "Conversation";
\echo '✓ Conversation table vacuumed and analyzed'

-- Customer table (3 rows inserted in Batch 3)
VACUUM (ANALYZE, VERBOSE) "Customer";
\echo '✓ Customer table vacuumed and analyzed'

-- Lead table (updated with customer_id in Batch 3)
VACUUM (ANALYZE, VERBOSE) "Lead";
\echo '✓ Lead table vacuumed and analyzed'

-- Job table (updated with customer_id in Batch 3)
VACUUM (ANALYZE, VERBOSE) "Job";
\echo '✓ Job table vacuumed and analyzed'

\echo ''

-- ═════════════════════════════════════════════════════════════════
-- 2. ANALYZE: Update Query Planner Statistics
-- ═══════════════════════════════════════════════════════════════

\echo '=== Step 2: Analyze All Context Memory Tables ==='
\echo ''

-- Analyze new tables for optimal query planning
ANALYZE "Customer";
ANALYZE "CustomerAddress";
ANALYZE "Conversation";
ANALYZE "Message";
ANALYZE "MemoryNote";
ANALYZE "JobItem";
ANALYZE "JobEvent";

\echo '✓ All context memory tables analyzed'
\echo ''

-- ═══════════════════════════════════════════════════════════════
-- 3. REINDEX: Rebuild Indexes for Optimal Performance
-- ═══════════════════════════════════════════════════════════════

\echo '=== Step 3: Reindex Context Memory Indexes ==='
\echo ''

-- Reindex critical context memory indexes
REINDEX INDEX CONCURRENTLY "Message_content_fts_idx";
\echo '✓ FTS index rebuilt'

REINDEX INDEX CONCURRENTLY "Message_conversation_id_created_at_idx";
\echo '✓ Message recency index rebuilt'

REINDEX INDEX CONCURRENTLY "Conversation_customer_id_started_at_idx";
\echo '✓ Conversation recency index rebuilt'

REINDEX INDEX CONCURRENTLY "Conversation_lead_open_unique";
\echo '✓ Open conversation unique index rebuilt'

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- 4. UPDATE AUTOVACUUM SETTINGS (for high-traffic tables)
-- ═══════════════════════════════════════════════════════════════

\echo '=== Step 4: Configure Autovacuum for Message Table ==='
\echo ''

-- Message table will grow quickly - tune autovacuum
ALTER TABLE "Message" SET (
  autovacuum_vacuum_scale_factor = 0.05,  -- Vacuum when 5% of rows updated (vs default 20%)
  autovacuum_analyze_scale_factor = 0.02, -- Analyze when 2% of rows updated (vs default 10%)
  autovacuum_vacuum_cost_delay = 10       -- Faster autovacuum (vs default 20ms)
);

\echo '✓ Message table autovacuum tuned for high traffic'

-- Conversation table
ALTER TABLE "Conversation" SET (
  autovacuum_vacuum_scale_factor = 0.1,   -- Vacuum when 10% of rows updated
  autovacuum_analyze_scale_factor = 0.05  -- Analyze when 5% of rows updated
);

\echo '✓ Conversation table autovacuum tuned'
\echo ''

-- ═══════════════════════════════════════════════════════════════
-- 5. VERIFY DATABASE HEALTH
-- ═══════════════════════════════════════════════════════════════

\echo '=== Step 5: Database Health Check ==='
\echo ''

-- Check vacuum and analyze stats
SELECT
  schemaname,
  relname,
  n_tup_ins as inserts,
  n_tup_upd as updates,
  n_tup_del as deletes,
  n_live_tup as live_rows,
  n_dead_tup as dead_rows,
  last_vacuum,
  last_autovacuum,
  last_analyze,
  last_autoanalyze
FROM pg_stat_user_tables
WHERE relname IN ('Customer', 'Conversation', 'Message', 'Lead', 'Job')
ORDER BY relname;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- 6. CHECK INDEX BLOAT
-- ═══════════════════════════════════════════════════════════════

\echo '=== Step 6: Index Health Check ==='
\echo ''

SELECT
  schemaname,
  relname as tablename,
  indexrelname as indexname,
  idx_scan as scans,
  idx_tup_read as tuples_read,
  idx_tup_fetch as tuples_fetched,
  pg_size_pretty(pg_relation_size(indexrelid)) as index_size
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
  AND relname IN ('Customer', 'Conversation', 'Message', 'CustomerAddress')
ORDER BY relname, indexrelname;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- 7. TABLE SIZE REPORT
-- ═══════════════════════════════════════════════════════════════

\echo '=== Step 7: Storage Analysis ==='
\echo ''

SELECT
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as total_size,
  pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) as table_size,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename) - pg_relation_size(schemaname||'.'||tablename)) as indexes_size,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename) - pg_relation_size(schemaname||'.'||tablename) - COALESCE((SELECT SUM(pg_relation_size(indexrelid)) FROM pg_index WHERE indrelid = (schemaname||'.'||tablename)::regclass), 0)) as toast_size
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('Customer', 'Conversation', 'Message', 'CustomerAddress', 'MemoryNote', 'JobItem', 'JobEvent', 'Lead', 'Job')
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- MAINTENANCE COMPLETE
-- ═══════════════════════════════════════════════════════════════

\echo '=== Batch 8 Maintenance Complete ==='
\echo ''
\echo 'Actions performed:'
\echo '  ✓ VACUUM ANALYZE on 5 tables'
\echo '  ✓ Statistics updated for query planner'
\echo '  ✓ Indexes rebuilt (4 critical indexes)'
\echo '  ✓ Autovacuum tuned for high-traffic tables'
\echo '  ✓ Database health verified'
\echo ''
\echo 'Performance improvements:'
\echo '  - Query planner has accurate statistics'
\echo '  - Indexes defragmented and optimized'
\echo '  - Autovacuum will run more frequently'
\echo '  - Dead rows reclaimed'
\echo ''
\echo 'Next: Run validation.sql to verify improvements'
\echo ''
