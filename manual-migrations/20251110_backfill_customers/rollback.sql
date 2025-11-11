-- Batch 3 Rollback Script - Remove Customer Backfill
-- WARNING: This will unlink all customers from leads/jobs and delete backfilled customers
-- Only run this if you need to completely reverse the backfill

-- ═══════════════════════════════════════════════════════════════
-- STEP 1: Backup current state (optional, manual)
-- ═══════════════════════════════════════════════════════════════

-- Before running rollback, consider backing up:
-- pg_dump -t '"Customer"' -t '"Lead"' -t '"Job"' $DATABASE_URL > batch3_backup.sql

-- ═══════════════════════════════════════════════════════════════
-- STEP 2: Unlink Jobs from Customers
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  jobs_unlinked INT;
BEGIN
  UPDATE "Job"
  SET customer_id = NULL
  WHERE customer_id IS NOT NULL;

  GET DIAGNOSTICS jobs_unlinked = ROW_COUNT;
  RAISE NOTICE '✓ Unlinked % jobs from customers', jobs_unlinked;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- STEP 3: Unlink Leads from Customers
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  leads_unlinked INT;
BEGIN
  UPDATE "Lead"
  SET customer_id = NULL
  WHERE customer_id IS NOT NULL;

  GET DIAGNOSTICS leads_unlinked = ROW_COUNT;
  RAISE NOTICE '✓ Unlinked % leads from customers', leads_unlinked;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- STEP 4: Delete Backfilled Customers
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  customers_deleted INT;
BEGIN
  -- Delete customers created by backfill script
  -- (identified by metadata.createdBy)
  DELETE FROM "Customer"
  WHERE metadata ? 'createdBy'
    AND metadata->>'createdBy' = 'backfill-customers.ts';

  GET DIAGNOSTICS customers_deleted = ROW_COUNT;
  RAISE NOTICE '✓ Deleted % backfilled customers', customers_deleted;
END $$;

-- Alternative: Delete ALL customers (more aggressive)
-- USE WITH EXTREME CAUTION
-- DELETE FROM "Customer";

-- ═══════════════════════════════════════════════════════════════
-- STEP 5: Delete CustomerAddress Records (if any)
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  addresses_deleted INT;
BEGIN
  -- Cascade delete should handle this, but explicit for clarity
  DELETE FROM "CustomerAddress"
  WHERE customer_id NOT IN (SELECT id FROM "Customer");

  GET DIAGNOSTICS addresses_deleted = ROW_COUNT;
  RAISE NOTICE '✓ Deleted % orphaned customer addresses', addresses_deleted;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- STEP 6: Delete Backfill Audit Logs (optional)
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  audit_logs_deleted INT;
BEGIN
  DELETE FROM "Audit"
  WHERE action IN ('backfill_customers', 'backfill_customers_dry_run');

  GET DIAGNOSTICS audit_logs_deleted = ROW_COUNT;
  RAISE NOTICE '✓ Deleted % backfill audit logs', audit_logs_deleted;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- STEP 7: Verification
-- ═══════════════════════════════════════════════════════════════

-- Verify rollback completed
SELECT
  'Customers' as table_name,
  COUNT(*) as remaining_count
FROM "Customer"

UNION ALL

SELECT
  'Leads with customer_id' as table_name,
  COUNT(*) as remaining_count
FROM "Lead"
WHERE customer_id IS NOT NULL

UNION ALL

SELECT
  'Jobs with customer_id' as table_name,
  COUNT(*) as remaining_count
FROM "Job"
WHERE customer_id IS NOT NULL

UNION ALL

SELECT
  'CustomerAddress' as table_name,
  COUNT(*) as remaining_count
FROM "CustomerAddress";

-- Expected: All counts should be 0

-- ═══════════════════════════════════════════════════════════════
-- NOTES
-- ═══════════════════════════════════════════════════════════════

-- After rollback, you can re-run the backfill script to apply fixes:
--   npx tsx scripts/migrations/backfill-customers.ts --dry-run
--   npx tsx scripts/migrations/backfill-customers.ts

-- To rollback only specific customers:
--   DELETE FROM "Customer" WHERE id = 'specific-uuid';
--   UPDATE "Lead" SET customer_id = NULL WHERE customer_id = 'specific-uuid';
--   UPDATE "Job" SET customer_id = NULL WHERE customer_id = 'specific-uuid';
