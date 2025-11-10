-- Batch 5 Rollback Script - Remove Integrity Indexes
-- Removes operational constraints added in Batch 5

-- ═══════════════════════════════════════════════════════════════
-- STEP 1: Drop Partial Unique Index
-- ═══════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS "Conversation_lead_open_unique";

-- ═══════════════════════════════════════════════════════════════
-- STEP 2: Drop Composite Recency Indexes
-- ═══════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS "Message_conversation_id_created_at_idx";
DROP INDEX IF EXISTS "Conversation_customer_id_started_at_idx";

-- Note: Customer phone/email indexes from Batch 1 are left intact
-- DROP INDEX IF EXISTS "Customer_phone_idx";
-- DROP INDEX IF EXISTS "Customer_email_idx";

-- ═══════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════

-- Verify indexes removed
SELECT
  'Indexes Remaining' as check_type,
  COUNT(*) as count
FROM pg_indexes
WHERE indexname IN (
  'Conversation_lead_open_unique',
  'Message_conversation_id_created_at_idx',
  'Conversation_customer_id_started_at_idx'
);
-- Expected: 0

-- Show all remaining conversation indexes
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename = 'Conversation'
ORDER BY indexname;
