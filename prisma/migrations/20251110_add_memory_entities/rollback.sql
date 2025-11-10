-- Batch 1 Rollback Script
-- WARNING: This will drop all context memory tables and customer relationships
-- Run this ONLY if you need to completely reverse Batch 1

-- Remove foreign key constraints from Lead and Job first
ALTER TABLE "Lead" DROP CONSTRAINT IF EXISTS "Lead_customer_id_fkey";
ALTER TABLE "Job" DROP CONSTRAINT IF EXISTS "Job_customer_id_fkey";

-- Drop indexes on Lead and Job
DROP INDEX IF EXISTS "Lead_customer_id_idx";
DROP INDEX IF EXISTS "Job_customer_id_idx";

-- Remove customer_id columns from existing tables
ALTER TABLE "Lead" DROP COLUMN IF EXISTS "customer_id";
ALTER TABLE "Job" DROP COLUMN IF EXISTS "customer_id";

-- Drop new tables (CASCADE will handle dependent objects)
DROP TABLE IF EXISTS "JobEvent" CASCADE;
DROP TABLE IF EXISTS "JobItem" CASCADE;
DROP TABLE IF EXISTS "MemoryNote" CASCADE;
DROP TABLE IF EXISTS "Message" CASCADE;
DROP TABLE IF EXISTS "Conversation" CASCADE;
DROP TABLE IF EXISTS "CustomerAddress" CASCADE;
DROP TABLE IF EXISTS "Customer" CASCADE;

-- Drop the MessageRole enum
DROP TYPE IF EXISTS "MessageRole";

-- Verify rollback
SELECT
  to_regclass('public."Customer"') AS customer_table_exists,
  to_regclass('public."Conversation"') AS conversation_table_exists,
  EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MessageRole') AS message_role_exists;
-- Expected: All NULL/false

SELECT column_name
FROM information_schema.columns
WHERE table_name = 'Lead' AND column_name = 'customer_id';
-- Expected: 0 rows (column removed)
