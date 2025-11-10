-- ═══════════════════════════════════════════════════════════════
-- Batch 7 Rollback: Remove NOT NULL Constraints
-- Reverts customer_id back to nullable if needed
-- ═══════════════════════════════════════════════════════════════

\echo '=== Rolling back Batch 7: Tighten Constraints ==='
\echo ''

-- ═══════════════════════════════════════════════════════════════
-- 1. REMOVE Lead.customer_id NOT NULL
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE "Lead"
ALTER COLUMN customer_id DROP NOT NULL;

\echo '✓ Lead.customer_id is now nullable again'

-- ═══════════════════════════════════════════════════════════════
-- 2. REMOVE Job.customer_id NOT NULL
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE "Job"
ALTER COLUMN customer_id DROP NOT NULL;

\echo '✓ Job.customer_id is now nullable again'

-- ═══════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════

-- Verify constraints are removed
DO $$
DECLARE
  lead_is_nullable BOOLEAN;
  job_is_nullable BOOLEAN;
BEGIN
  -- Check Lead.customer_id is nullable
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'Lead'
      AND column_name = 'customer_id'
      AND is_nullable = 'YES'
  ) INTO lead_is_nullable;

  -- Check Job.customer_id is nullable
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'Job'
      AND column_name = 'customer_id'
      AND is_nullable = 'YES'
  ) INTO job_is_nullable;

  IF lead_is_nullable AND job_is_nullable THEN
    RAISE NOTICE '✓ Rollback verification passed: Both columns nullable';
  ELSE
    RAISE WARNING 'Rollback verification failed: Columns may still be NOT NULL';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- SUMMARY
-- ═══════════════════════════════════════════════════════════════

\echo ''
\echo '=== Batch 7 Rollback Complete ==='
\echo ''
\echo 'Changes reverted:'
\echo '  ✓ Lead.customer_id is nullable'
\echo '  ✓ Job.customer_id is nullable'
\echo ''
\echo 'Impact:'
\echo '  - Leads can be created without customer_id'
\echo '  - Jobs can be created without customer_id'
\echo '  - Application must handle NULL customer_id'
\echo ''
\echo 'Warning: Only rollback if absolutely necessary!'
\echo 'Re-apply Batch 7 when ready to enforce constraints again.'
\echo ''
