-- ═══════════════════════════════════════════════════════════════
-- Batch 7: Tighten Constraints
-- Enforce required customer relationships after data validation
-- ═══════════════════════════════════════════════════════════════

-- PRE-FLIGHT CHECK: Ensure no NULL values exist
-- This migration will fail if any NULL customer_id values found

DO $$
DECLARE
  unlinked_leads INTEGER;
  unlinked_jobs INTEGER;
BEGIN
  -- Check Lead table
  SELECT COUNT(*) INTO unlinked_leads
  FROM "Lead"
  WHERE customer_id IS NULL;

  IF unlinked_leads > 0 THEN
    RAISE EXCEPTION 'Cannot tighten constraints: % leads have NULL customer_id. Run Batch 3 backfill first.', unlinked_leads;
  END IF;

  -- Check Job table
  SELECT COUNT(*) INTO unlinked_jobs
  FROM "Job"
  WHERE customer_id IS NULL;

  IF unlinked_jobs > 0 THEN
    RAISE EXCEPTION 'Cannot tighten constraints: % jobs have NULL customer_id. Run Batch 3 backfill first.', unlinked_jobs;
  END IF;

  RAISE NOTICE '✓ Pre-flight check passed: All leads and jobs have customer_id';
END $$;

-- ═══════════════════════════════════════════════════════════════
-- 1. MAKE Lead.customer_id NOT NULL
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE "Lead"
ALTER COLUMN customer_id SET NOT NULL;

-- ✓ Lead.customer_id is now NOT NULL

-- ═══════════════════════════════════════════════════════════════
-- 2. MAKE Job.customer_id NOT NULL
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE "Job"
ALTER COLUMN customer_id SET NOT NULL;

-- ✓ Job.customer_id is now NOT NULL

-- ═══════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════

-- Verify NOT NULL constraints are in place
DO $$
DECLARE
  lead_constraint_exists BOOLEAN;
  job_constraint_exists BOOLEAN;
BEGIN
  -- Check Lead.customer_id NOT NULL
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'Lead'
      AND column_name = 'customer_id'
      AND is_nullable = 'NO'
  ) INTO lead_constraint_exists;

  -- Check Job.customer_id NOT NULL
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'Job'
      AND column_name = 'customer_id'
      AND is_nullable = 'NO'
  ) INTO job_constraint_exists;

  IF lead_constraint_exists AND job_constraint_exists THEN
    RAISE NOTICE '✓ Verification passed: Both constraints in place';
  ELSE
    RAISE WARNING 'Verification failed: Constraints may not be applied correctly';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- SUMMARY
-- ═══════════════════════════════════════════════════════════════
--
-- === Batch 7 Migration Complete ===
--
-- Changes applied:
--   ✓ Lead.customer_id SET NOT NULL
--   ✓ Job.customer_id SET NOT NULL
--
-- Impact:
--   - New leads MUST have customer_id
--   - New jobs MUST have customer_id
--   - Database enforces customer relationship
