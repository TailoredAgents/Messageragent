-- Batch 2 Rollback Script - Remove FTS Indexes
-- WARNING: This removes full-text search capability on Message.content

-- Drop FTS GIN index
DROP INDEX IF EXISTS "Message_content_fts_idx";

-- Drop role index
DROP INDEX IF EXISTS "Message_role_idx";

-- Verify indexes removed
SELECT
  COUNT(*) as remaining_fts_indexes
FROM pg_indexes
WHERE indexname IN ('Message_content_fts_idx', 'Message_role_idx');
-- Expected: 0
