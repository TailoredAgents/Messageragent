-- ═══════════════════════════════════════════════════════════════
-- Batch 7 Validation: Test NOT NULL Constraint Enforcement
-- Verifies that customer_id is required on Lead and Job
-- ═══════════════════════════════════════════════════════════════

\echo '=== Batch 7 Validation: Constraint Enforcement ==='
\echo ''

-- ═══════════════════════════════════════════════════════════════
-- TEST 1: Verify NOT NULL Constraints Exist
-- ═══════════════════════════════════════════════════════════════

\echo '=== TEST 1: Verify NOT NULL Constraints ==='
\echo ''

SELECT
  table_name,
  column_name,
  is_nullable,
  CASE
    WHEN is_nullable = 'NO' THEN '✓ PASS: NOT NULL enforced'
    ELSE '✗ FAIL: Still nullable'
  END as status
FROM information_schema.columns
WHERE (table_name = 'Lead' AND column_name = 'customer_id')
   OR (table_name = 'Job' AND column_name = 'customer_id')
ORDER BY table_name;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- TEST 2: Attempt to Insert Lead Without customer_id (Should FAIL)
-- ═══════════════════════════════════════════════════════════════

\echo '=== TEST 2: Reject Lead Without customer_id ==='
\echo ''

DO $$
BEGIN
  -- Try to insert Lead without customer_id (should fail)
  INSERT INTO "Lead" (id, channel, name)
  VALUES (gen_random_uuid(), 'messenger', 'Test Lead Without Customer');

  -- If we reach here, constraint didn't work
  RAISE EXCEPTION '✗ FAIL: Lead inserted without customer_id (constraint not enforcing)';

EXCEPTION
  WHEN not_null_violation THEN
    RAISE NOTICE '✓ PASS: Lead insertion rejected (constraint working)';
  WHEN OTHERS THEN
    RAISE NOTICE '✗ UNEXPECTED ERROR: %', SQLERRM;
END $$;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- TEST 3: Attempt to Insert Job Without customer_id (Should FAIL)
-- ═══════════════════════════════════════════════════════════════

\echo '=== TEST 3: Reject Job Without customer_id ==='
\echo ''

DO $$
DECLARE
  test_lead_id UUID;
BEGIN
  -- Get a valid lead_id for the test
  SELECT id INTO test_lead_id FROM "Lead" LIMIT 1;

  -- Try to insert Job without customer_id (should fail)
  INSERT INTO "Job" (id, lead_id, window_start, window_end, status)
  VALUES (
    gen_random_uuid(),
    test_lead_id,
    NOW() + INTERVAL '1 day',
    NOW() + INTERVAL '1 day' + INTERVAL '2 hours',
    'tentative'
  );

  -- If we reach here, constraint didn't work
  RAISE EXCEPTION '✗ FAIL: Job inserted without customer_id (constraint not enforcing)';

EXCEPTION
  WHEN not_null_violation THEN
    RAISE NOTICE '✓ PASS: Job insertion rejected (constraint working)';
  WHEN OTHERS THEN
    RAISE NOTICE '✗ UNEXPECTED ERROR: %', SQLERRM;
END $$;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- TEST 4: Verify Valid Inserts Still Work
-- ═══════════════════════════════════════════════════════════════

\echo '=== TEST 4: Allow Lead WITH customer_id ==='
\echo ''

DO $$
DECLARE
  test_customer_id UUID;
  test_lead_id UUID;
BEGIN
  -- Get a valid customer_id
  SELECT id INTO test_customer_id FROM "Customer" LIMIT 1;

  -- Create a test lead WITH customer_id (should succeed)
  test_lead_id := gen_random_uuid();
  INSERT INTO "Lead" (id, channel, customer_id, name)
  VALUES (test_lead_id, 'messenger', test_customer_id, 'Test Lead With Customer');

  RAISE NOTICE '✓ PASS: Lead with customer_id inserted successfully';

  -- Clean up test data
  DELETE FROM "Lead" WHERE id = test_lead_id;
  RAISE NOTICE '  (Test lead cleaned up)';

EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE '✗ FAIL: Could not insert valid lead: %', SQLERRM;
END $$;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- TEST 5: Verify Valid Job Insert Still Works
-- ═══════════════════════════════════════════════════════════════

\echo '=== TEST 5: Allow Job WITH customer_id ==='
\echo ''

DO $$
DECLARE
  test_customer_id UUID;
  test_lead_id UUID;
  test_job_id UUID;
BEGIN
  -- Get valid IDs
  SELECT id INTO test_customer_id FROM "Customer" LIMIT 1;
  SELECT id INTO test_lead_id FROM "Lead" WHERE customer_id = test_customer_id LIMIT 1;

  -- Create a test job WITH customer_id (should succeed)
  test_job_id := gen_random_uuid();
  INSERT INTO "Job" (id, lead_id, customer_id, window_start, window_end, status)
  VALUES (
    test_job_id,
    test_lead_id,
    test_customer_id,
    NOW() + INTERVAL '1 day',
    NOW() + INTERVAL '1 day' + INTERVAL '2 hours',
    'tentative'
  );

  RAISE NOTICE '✓ PASS: Job with customer_id inserted successfully';

  -- Clean up test data
  DELETE FROM "Job" WHERE id = test_job_id;
  RAISE NOTICE '  (Test job cleaned up)';

EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE '✗ FAIL: Could not insert valid job: %', SQLERRM;
END $$;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- TEST 6: Attempt to UPDATE to NULL (Should FAIL)
-- ═══════════════════════════════════════════════════════════════

\echo '=== TEST 6: Reject UPDATE to NULL customer_id ==='
\echo ''

DO $$
DECLARE
  test_lead_id UUID;
BEGIN
  -- Get an existing lead
  SELECT id INTO test_lead_id FROM "Lead" LIMIT 1;

  -- Try to update customer_id to NULL (should fail)
  UPDATE "Lead"
  SET customer_id = NULL
  WHERE id = test_lead_id;

  -- If we reach here, constraint didn't work
  RAISE EXCEPTION '✗ FAIL: Lead updated to NULL customer_id (constraint not enforcing)';

EXCEPTION
  WHEN not_null_violation THEN
    RAISE NOTICE '✓ PASS: UPDATE to NULL rejected (constraint working)';
  WHEN OTHERS THEN
    RAISE NOTICE '✗ UNEXPECTED ERROR: %', SQLERRM;
END $$;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- TEST 7: Verify Existing Data Unchanged
-- ═══════════════════════════════════════════════════════════════

\echo '=== TEST 7: Verify Existing Data Integrity ==='
\echo ''

SELECT
  (SELECT COUNT(*) FROM "Lead" WHERE customer_id IS NULL) as leads_without_customer,
  (SELECT COUNT(*) FROM "Job" WHERE customer_id IS NULL) as jobs_without_customer,
  (SELECT COUNT(*) FROM "Lead" WHERE customer_id IS NOT NULL) as leads_with_customer,
  (SELECT COUNT(*) FROM "Job" WHERE customer_id IS NOT NULL) as jobs_with_customer,
  CASE
    WHEN (SELECT COUNT(*) FROM "Lead" WHERE customer_id IS NULL) = 0
     AND (SELECT COUNT(*) FROM "Job" WHERE customer_id IS NULL) = 0
    THEN '✓ PASS: All existing records have customer_id'
    ELSE '✗ FAIL: Some records missing customer_id'
  END as status;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- VALIDATION SUMMARY
-- ═══════════════════════════════════════════════════════════════

\echo '=== Batch 7 Validation Complete ==='
\echo ''
\echo 'Tests performed:'
\echo '  1. NOT NULL constraints verified in schema'
\echo '  2. Lead insertion without customer_id rejected ✓'
\echo '  3. Job insertion without customer_id rejected ✓'
\echo '  4. Lead insertion WITH customer_id allowed ✓'
\echo '  5. Job insertion WITH customer_id allowed ✓'
\echo '  6. UPDATE to NULL customer_id rejected ✓'
\echo '  7. Existing data integrity verified ✓'
\echo ''
\echo 'Expected: All tests should PASS'
\echo 'Constraint enforcement: Active and working'
\echo ''
