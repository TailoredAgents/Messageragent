-- Batch 3 Validation Queries - Customer Backfill

-- ═══════════════════════════════════════════════════════════════
-- 1. CUSTOMER COUNTS
-- ═══════════════════════════════════════════════════════════════

-- Total customers created
SELECT COUNT(*) as total_customers FROM "Customer";
-- Expected: > 0 (at least one customer per lead group)

-- Customer distribution by grouping type
SELECT
  metadata->>'groupType' as group_type,
  COUNT(*) as count,
  ROUND(AVG((metadata->>'leadCount')::int), 2) as avg_leads_per_customer
FROM "Customer"
WHERE metadata ? 'groupType'
GROUP BY metadata->>'groupType'
ORDER BY count DESC;
-- Expected: psid, phone, email, individual types with counts

-- ═══════════════════════════════════════════════════════════════
-- 2. LEAD LINKING
-- ═══════════════════════════════════════════════════════════════

-- Leads with customer links
SELECT
  COUNT(*) FILTER (WHERE customer_id IS NOT NULL) as linked,
  COUNT(*) FILTER (WHERE customer_id IS NULL) as unlinked,
  COUNT(*) as total,
  ROUND(100.0 * COUNT(*) FILTER (WHERE customer_id IS NOT NULL) / COUNT(*), 2) as percent_linked
FROM "Lead";
-- Expected: 100% or close to 100% linked

-- Leads without customers (should be 0 or very few)
SELECT
  id,
  channel,
  name,
  phone,
  email,
  messenger_psid,
  created_at
FROM "Lead"
WHERE customer_id IS NULL
ORDER BY created_at DESC
LIMIT 10;
-- Expected: 0 rows or only recent leads

-- ═══════════════════════════════════════════════════════════════
-- 3. JOB LINKING
-- ═══════════════════════════════════════════════════════════════

-- Jobs with customer links
SELECT
  COUNT(*) FILTER (WHERE customer_id IS NOT NULL) as linked,
  COUNT(*) FILTER (WHERE customer_id IS NULL) as unlinked,
  COUNT(*) as total,
  ROUND(100.0 * COUNT(*) FILTER (WHERE customer_id IS NOT NULL) / COUNT(*), 2) as percent_linked
FROM "Job";
-- Expected: 100% or close to 100% linked

-- Jobs without customers (should be 0)
SELECT
  j.id,
  j.lead_id,
  l.customer_id as lead_customer_id,
  j.customer_id as job_customer_id,
  j.status,
  j.created_at
FROM "Job" j
LEFT JOIN "Lead" l ON j.lead_id = l.id
WHERE j.customer_id IS NULL
ORDER BY j.created_at DESC
LIMIT 10;
-- Expected: 0 rows

-- ═══════════════════════════════════════════════════════════════
-- 4. DATA INTEGRITY CHECKS
-- ═══════════════════════════════════════════════════════════════

-- Verify Job.customerId matches Lead.customerId
SELECT
  COUNT(*) as mismatched_jobs
FROM "Job" j
INNER JOIN "Lead" l ON j.lead_id = l.id
WHERE j.customer_id IS DISTINCT FROM l.customer_id;
-- Expected: 0 (all jobs should match their lead's customer)

-- Check for orphaned customer references (should not exist)
SELECT
  COUNT(*) as orphaned_lead_refs
FROM "Lead"
WHERE customer_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Customer" WHERE id = "Lead".customer_id
  );
-- Expected: 0

-- ═══════════════════════════════════════════════════════════════
-- 5. GROUPING QUALITY CHECKS
-- ═══════════════════════════════════════════════════════════════

-- Customers with multiple leads (merged)
SELECT
  c.id,
  c.phone,
  c.email,
  c.metadata->>'groupType' as group_type,
  COUNT(l.id) as lead_count
FROM "Customer" c
INNER JOIN "Lead" l ON l.customer_id = c.id
GROUP BY c.id, c.phone, c.email, c.metadata
HAVING COUNT(l.id) > 1
ORDER BY COUNT(l.id) DESC
LIMIT 20;
-- Expected: Customers with multiple leads (common for returning customers)

-- Check for duplicate phone numbers (should not exist after normalization)
SELECT
  phone,
  COUNT(*) as customer_count,
  ARRAY_AGG(id) as customer_ids
FROM "Customer"
WHERE phone IS NOT NULL
GROUP BY phone
HAVING COUNT(*) > 1;
-- Expected: 0 rows (phones should be normalized and unique)

-- Check for duplicate emails (conservative merge, may exist)
SELECT
  email,
  COUNT(*) as customer_count,
  ARRAY_AGG(id) as customer_ids
FROM "Customer"
WHERE email IS NOT NULL
GROUP BY email
HAVING COUNT(*) > 1
LIMIT 10;
-- Expected: Few or 0 rows (emails should mostly be unique)

-- ═══════════════════════════════════════════════════════════════
-- 6. AUDIT LOG VERIFICATION
-- ═══════════════════════════════════════════════════════════════

-- Check backfill audit entries
SELECT
  id,
  actor,
  action,
  payload->>'timestamp' as run_timestamp,
  payload->'stats'->>'customersCreated' as customers_created,
  payload->'stats'->>'leadsLinked' as leads_linked,
  payload->'stats'->>'jobsLinked' as jobs_linked,
  created_at
FROM "Audit"
WHERE action IN ('backfill_customers', 'backfill_customers_dry_run')
ORDER BY created_at DESC
LIMIT 5;
-- Expected: At least one entry with backfill statistics

-- ═══════════════════════════════════════════════════════════════
-- 7. SAMPLE DATA INSPECTION
-- ═══════════════════════════════════════════════════════════════

-- Sample customers with their leads
SELECT
  c.id as customer_id,
  c.name as customer_name,
  c.phone,
  c.email,
  c.metadata->>'groupType' as group_type,
  STRING_AGG(l.id::text, ', ') as lead_ids,
  COUNT(l.id) as lead_count
FROM "Customer" c
LEFT JOIN "Lead" l ON l.customer_id = c.id
GROUP BY c.id, c.name, c.phone, c.email, c.metadata
ORDER BY COUNT(l.id) DESC
LIMIT 10;
-- Expected: Sample of customers with their associated leads

-- Sample messenger PSID groupings
SELECT
  c.id,
  c.phone,
  l.messenger_psid,
  COUNT(*) OVER (PARTITION BY l.messenger_psid) as leads_with_same_psid
FROM "Customer" c
INNER JOIN "Lead" l ON l.customer_id = c.id
WHERE l.messenger_psid IS NOT NULL
LIMIT 10;
-- Expected: Leads with same PSID should have same customer_id

-- ═══════════════════════════════════════════════════════════════
-- 8. COMPREHENSIVE SUMMARY
-- ═══════════════════════════════════════════════════════════════

SELECT
  'Customers' as entity,
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE metadata ? 'groupType') as with_metadata,
  COUNT(*) FILTER (WHERE phone IS NOT NULL) as with_phone,
  COUNT(*) FILTER (WHERE email IS NOT NULL) as with_email
FROM "Customer"

UNION ALL

SELECT
  'Leads' as entity,
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE customer_id IS NOT NULL) as linked,
  COUNT(*) FILTER (WHERE messenger_psid IS NOT NULL) as with_psid,
  COUNT(*) FILTER (WHERE phone IS NOT NULL) as with_phone
FROM "Lead"

UNION ALL

SELECT
  'Jobs' as entity,
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE customer_id IS NOT NULL) as linked,
  0 as other1,
  0 as other2
FROM "Job";
-- Expected: Summary of all entity counts and linkage
