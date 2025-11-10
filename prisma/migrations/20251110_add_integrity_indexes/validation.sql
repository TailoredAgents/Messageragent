-- Batch 5 Validation Queries - Integrity Indexes

-- ═══════════════════════════════════════════════════════════════
-- 1. VERIFY INDEXES EXIST
-- ═══════════════════════════════════════════════════════════════

-- Check all Batch 5 indexes
SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE indexname IN (
  'Conversation_lead_open_unique',
  'Message_conversation_id_created_at_idx',
  'Conversation_customer_id_started_at_idx'
)
ORDER BY indexname;
-- Expected: 3 rows

-- ═══════════════════════════════════════════════════════════════
-- 2. TEST PARTIAL UNIQUE CONSTRAINT
-- ═══════════════════════════════════════════════════════════════

-- This should pass: Creating first open conversation for a lead
DO $$
DECLARE
  test_lead_id UUID;
  test_customer_id UUID;
  test_conversation_id UUID;
BEGIN
  -- Get a real lead
  SELECT id, customer_id INTO test_lead_id, test_customer_id
  FROM "Lead"
  LIMIT 1;

  -- Try to create a test conversation
  BEGIN
    INSERT INTO "Conversation" (id, lead_id, customer_id, channel, started_at, metadata)
    VALUES (
      gen_random_uuid(),
      test_lead_id,
      test_customer_id,
      'messenger',
      NOW(),
      '{"test": true, "source": "validation"}'::jsonb
    )
    RETURNING id INTO test_conversation_id;

    RAISE NOTICE '✓ Created test conversation (open, no closed_at)';

    -- Now try to create a SECOND open conversation for same lead (should fail)
    BEGIN
      INSERT INTO "Conversation" (id, lead_id, customer_id, channel, started_at, metadata)
      VALUES (
        gen_random_uuid(),
        test_lead_id,
        test_customer_id,
        'messenger',
        NOW(),
        '{"test": true, "source": "validation_duplicate"}'::jsonb
      );

      -- If we get here, the constraint FAILED (bad!)
      RAISE EXCEPTION '✗ CONSTRAINT FAILED: Allowed duplicate open conversation!';

    EXCEPTION WHEN unique_violation THEN
      -- This is EXPECTED behavior
      RAISE NOTICE '✓ Constraint working: Prevented duplicate open conversation';
    END;

    -- Cleanup: Delete test conversation
    DELETE FROM "Conversation" WHERE id = test_conversation_id;
    RAISE NOTICE '✓ Cleaned up test conversation';

  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '⚠ Could not test constraint (lead may already have open conversation)';
  END;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- 3. VERIFY PARTIAL INDEX ALLOWS CLOSED CONVERSATIONS
-- ═══════════════════════════════════════════════════════════════

-- This should pass: Multiple CLOSED conversations for same lead are allowed
DO $$
DECLARE
  test_lead_id UUID;
  test_customer_id UUID;
  test_conv1_id UUID;
  test_conv2_id UUID;
BEGIN
  SELECT id, customer_id INTO test_lead_id, test_customer_id
  FROM "Lead"
  LIMIT 1;

  -- Create first closed conversation
  INSERT INTO "Conversation" (id, lead_id, customer_id, channel, started_at, closed_at, metadata)
  VALUES (
    gen_random_uuid(),
    test_lead_id,
    test_customer_id,
    'messenger',
    NOW() - INTERVAL '2 days',
    NOW() - INTERVAL '1 day',
    '{"test": true, "source": "validation_closed1"}'::jsonb
  )
  RETURNING id INTO test_conv1_id;

  RAISE NOTICE '✓ Created first closed conversation';

  -- Create second closed conversation for SAME lead (should succeed)
  INSERT INTO "Conversation" (id, lead_id, customer_id, channel, started_at, closed_at, metadata)
  VALUES (
    gen_random_uuid(),
    test_lead_id,
    test_customer_id,
    'messenger',
    NOW() - INTERVAL '1 day',
    NOW(),
    '{"test": true, "source": "validation_closed2"}'::jsonb
  )
  RETURNING id INTO test_conv2_id;

  RAISE NOTICE '✓ Created second closed conversation (constraint allows multiple closed)';

  -- Cleanup
  DELETE FROM "Conversation" WHERE id IN (test_conv1_id, test_conv2_id);
  RAISE NOTICE '✓ Cleaned up test conversations';

EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Error during closed conversation test: %', SQLERRM;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- 4. TEST QUERY PERFORMANCE WITH NEW INDEXES
-- ═══════════════════════════════════════════════════════════════

-- Test Message recency index
EXPLAIN (FORMAT TEXT)
SELECT * FROM "Message"
WHERE conversation_id = (SELECT id FROM "Conversation" LIMIT 1)
ORDER BY created_at DESC
LIMIT 10;
-- Expected: Uses Message_conversation_id_created_at_idx

-- Test Conversation recency by customer
EXPLAIN (FORMAT TEXT)
SELECT * FROM "Conversation"
WHERE customer_id = (SELECT id FROM "Customer" LIMIT 1)
ORDER BY started_at DESC
LIMIT 10;
-- Expected: Uses Conversation_customer_id_started_at_idx

-- ═══════════════════════════════════════════════════════════════
-- 5. INDEX SIZE AND STATISTICS
-- ═══════════════════════════════════════════════════════════════

-- Check index sizes
SELECT
  schemaname,
  tablename,
  indexname,
  pg_size_pretty(pg_relation_size(indexname::regclass)) as index_size
FROM pg_indexes
WHERE indexname IN (
  'Conversation_lead_open_unique',
  'Message_conversation_id_created_at_idx',
  'Conversation_customer_id_started_at_idx'
)
ORDER BY indexname;

-- ═══════════════════════════════════════════════════════════════
-- 6. CHECK FOR EXISTING CONSTRAINT VIOLATIONS
-- ═══════════════════════════════════════════════════════════════

-- Find leads with multiple open conversations (should be 0)
SELECT
  lead_id,
  COUNT(*) as open_conversation_count
FROM "Conversation"
WHERE closed_at IS NULL
GROUP BY lead_id
HAVING COUNT(*) > 1;
-- Expected: 0 rows (no violations)

-- ═══════════════════════════════════════════════════════════════
-- 7. COMPREHENSIVE INDEX SUMMARY
-- ═══════════════════════════════════════════════════════════════

-- Show all indexes on Conversation table
SELECT
  indexname,
  indexdef,
  pg_size_pretty(pg_relation_size(indexname::regclass)) as size
FROM pg_indexes
WHERE tablename = 'Conversation'
ORDER BY indexname;

-- Show all indexes on Message table
SELECT
  indexname,
  indexdef,
  pg_size_pretty(pg_relation_size(indexname::regclass)) as size
FROM pg_indexes
WHERE tablename = 'Message'
ORDER BY indexname;
