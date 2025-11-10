-- Batch 4 Rollback Script - Remove Conversation/Message Backfill
-- WARNING: This will delete all backfilled conversations and messages
-- Only run this if you need to completely reverse the backfill

-- ═══════════════════════════════════════════════════════════════
-- STEP 1: Delete backfilled Messages
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  messages_deleted INT;
BEGIN
  -- Delete messages created by backfill (identified by metadata.source)
  DELETE FROM "Message"
  WHERE metadata ? 'source'
    AND metadata->>'source' = 'audit_backfill';

  GET DIAGNOSTICS messages_deleted = ROW_COUNT;
  RAISE NOTICE '✓ Deleted % backfilled messages', messages_deleted;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- STEP 2: Delete backfilled Conversations
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  conversations_deleted INT;
BEGIN
  -- Delete conversations created by backfill
  DELETE FROM "Conversation"
  WHERE metadata ? 'source'
    AND metadata->>'source' = 'audit_backfill';

  GET DIAGNOSTICS conversations_deleted = ROW_COUNT;
  RAISE NOTICE '✓ Deleted % backfilled conversations', conversations_deleted;
END $$;

-- Alternative: Delete only empty conversations
-- DELETE FROM "Conversation"
-- WHERE metadata ? 'source'
--   AND metadata->>'source' = 'audit_backfill'
--   AND NOT EXISTS (
--     SELECT 1 FROM "Message" WHERE conversation_id = "Conversation".id
--   );

-- ═══════════════════════════════════════════════════════════════
-- STEP 3: Delete backfill audit logs (optional)
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  audit_logs_deleted INT;
BEGIN
  DELETE FROM "Audit"
  WHERE action IN ('backfill_conversations_messages', 'backfill_conversations_messages_dry_run');

  GET DIAGNOSTICS audit_logs_deleted = ROW_COUNT;
  RAISE NOTICE '✓ Deleted % backfill audit logs', audit_logs_deleted;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- STEP 4: Verification
-- ═══════════════════════════════════════════════════════════════

-- Verify rollback completed
SELECT
  'Backfilled Messages' as item,
  COUNT(*) as remaining_count
FROM "Message"
WHERE metadata ? 'source'
  AND metadata->>'source' = 'audit_backfill'

UNION ALL

SELECT
  'Backfilled Conversations' as item,
  COUNT(*) as remaining_count
FROM "Conversation"
WHERE metadata ? 'source'
  AND metadata->>'source' = 'audit_backfill'

UNION ALL

SELECT
  'Total Messages' as item,
  COUNT(*) as remaining_count
FROM "Message"

UNION ALL

SELECT
  'Total Conversations' as item,
  COUNT(*) as remaining_count
FROM "Conversation";

-- Expected: Backfilled counts should be 0

-- ═══════════════════════════════════════════════════════════════
-- NOTES
-- ═══════════════════════════════════════════════════════════════

-- After rollback, you can re-run the backfill script:
--   npx tsx scripts/migrations/backfill-conversations-messages.ts --dry-run
--   npx tsx scripts/migrations/backfill-conversations-messages.ts

-- To rollback only specific conversations/messages:
--   DELETE FROM "Message" WHERE conversation_id = 'specific-uuid';
--   DELETE FROM "Conversation" WHERE id = 'specific-uuid';
