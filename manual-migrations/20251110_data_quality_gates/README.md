# Batch 6 — Data Quality Gates

## Objective
Confirm backfills are complete and consistent before tightening constraints or enabling full production features.

## Status
- **Created**: 2025-11-10
- **Applied**: ❌ (Pending)
- **Type**: Validation (no schema changes)

---

## Overview

This batch performs **comprehensive data quality checks** to ensure:
1. All leads linked to customers (100% coverage)
2. All jobs linked to customers (100% coverage)
3. No orphaned foreign keys
4. Conversations exist for active leads
5. Message histories are present
6. Constraint enforcement is working

**Key Feature**: This is a **read-only validation batch** - no data modifications

---

## Gates Checked

### Gate 1: Lead Coverage ✓
**Requirement**: `SELECT COUNT(*) FROM "Lead" WHERE customer_id IS NULL` = 0

**Purpose**: Ensures every lead is linked to a customer after Batch 3 backfill

**Expected**: 0 unlinked leads

---

### Gate 2: Job Coverage ✓
**Requirement**: `SELECT COUNT(*) FROM "Job" WHERE customer_id IS NULL` = 0

**Purpose**: Ensures every job is linked to a customer after Batch 3 backfill

**Expected**: 0 unlinked jobs

---

### Gate 3: Customer-Lead Consistency ✓
**Requirement**: All `Lead.customer_id` must point to valid `Customer.id`

**Purpose**: Validates foreign key integrity (no orphaned references)

**Expected**: 0 orphaned leads

---

### Gate 4: Customer-Job Consistency ✓
**Requirement**: All `Job.customer_id` must point to valid `Customer.id`

**Purpose**: Validates foreign key integrity (no orphaned references)

**Expected**: 0 orphaned jobs

---

### Gate 5: Conversation Coverage ℹ️
**Requirement**: Leads with message history should have conversations

**Purpose**: Validates Batch 4 backfill created conversations for active leads

**Expected**: All leads with audit records have conversations

---

### Gate 6: Message History Presence ℹ️
**Requirement**: Conversations should have messages

**Purpose**: Validates Batch 4 backfill populated message histories

**Expected**: No empty conversations (or very few)

---

### Gate 7: Random Sampling ℹ️
**Requirement**: Sample customers show correct linkage

**Purpose**: Manual verification of data quality

**Expected**: Sample shows:
- Customers with expected lead count
- Matching PSID/phone/email grouping
- Conversation and job counts align

---

### Gate 8: Message Role Distribution ℹ️
**Requirement**: Messages have balanced user/assistant roles

**Purpose**: Validates message role mapping from audit logs

**Expected**: Mix of user and assistant messages (roughly balanced)

---

### Gate 9: Conversation Integrity ✓
**Requirement**: Each lead has max 1 open conversation

**Purpose**: Validates Batch 5 partial unique index is enforcing constraint

**Expected**: All leads have 0 or 1 open conversation (no duplicates)

---

### Gate 10: Data Completeness Summary ℹ️
**Requirement**: Overall statistics look reasonable

**Purpose**: Sanity check on data volumes

**Expected**:
- Customer count matches expected unique customers
- Lead/job linkage at 100%
- Message count matches backfill results

---

### Gate 11: Index Usage Statistics ℹ️
**Requirement**: Context memory indexes exist and may be used

**Purpose**: Validates Batch 2 and Batch 5 indexes are registered

**Expected**: All indexes present (usage may be 0 if no queries yet)

---

## Usage

### Run Validation

```bash
export DATABASE_URL="postgresql://..."

# Run all gates
psql "$DATABASE_URL" \
  -f prisma/migrations/20251110_data_quality_gates/validation.sql
```

### Expected Output

```
=== GATE 1: Lead Coverage ===
✓ PASS: All leads linked to customers

=== GATE 2: Job Coverage ===
✓ PASS: All jobs linked to customers

=== GATE 3: Customer-Lead Consistency ===
✓ PASS: All lead.customer_id valid

=== GATE 4: Customer-Job Consistency ===
✓ PASS: All job.customer_id valid

=== GATE 5: Conversation Coverage ===
✓ PASS: All leads with history have conversations

=== GATE 6: Message History Presence ===
✓ PASS: All conversations have messages

=== GATE 7: Random Sampling - Customer Linkage ===
[Shows sample of 3 customers with counts]

=== GATE 8: Message Role Distribution ===
[Shows role counts and percentages]

=== GATE 9: Conversation Integrity ===
✓ OK: Single open conversation (for each lead)

=== GATE 10: Overall Data Completeness ===
[Shows summary statistics]

=== GATE 11: Index Usage ===
[Shows index existence and usage stats]

=== BATCH 6 VALIDATION COMPLETE ===
```

---

## Fixing Failed Gates

### Gate 1 or 2 Failure: Missing customer_id

**Symptom**: Unlinked leads or jobs found

**Fix**: Re-run Batch 3 backfill script
```bash
npx tsx scripts/migrations/backfill-customers.ts --verbose
```

**Alternative**: Manual linking
```sql
-- Find unlinked leads
SELECT id, name, phone, email FROM "Lead" WHERE customer_id IS NULL;

-- Create customer and link
WITH new_customer AS (
  INSERT INTO "Customer" (id, name, phone, email, metadata)
  VALUES (gen_random_uuid(), 'Name', '+1234567890', 'email@example.com', '{}')
  RETURNING id
)
UPDATE "Lead"
SET customer_id = (SELECT id FROM new_customer)
WHERE id = 'LEAD_ID_HERE';
```

---

### Gate 3 or 4 Failure: Orphaned References

**Symptom**: customer_id points to non-existent customer

**Fix**: Create missing customer or relink
```sql
-- Check which customer IDs are missing
SELECT DISTINCT l.customer_id
FROM "Lead" l
LEFT JOIN "Customer" c ON l.customer_id = c.id
WHERE l.customer_id IS NOT NULL AND c.id IS NULL;

-- Option 1: Create missing customer
INSERT INTO "Customer" (id, name, metadata)
VALUES ('MISSING_CUSTOMER_ID', 'Recovered Customer', '{"recovered": true}');

-- Option 2: Relink to correct customer
UPDATE "Lead"
SET customer_id = 'CORRECT_CUSTOMER_ID'
WHERE customer_id = 'MISSING_CUSTOMER_ID';
```

---

### Gate 5 Failure: Missing Conversations

**Symptom**: Leads with audit history but no conversations

**Fix**: Re-run Batch 4 backfill script
```bash
npx tsx scripts/migrations/backfill-conversations-messages.ts --verbose
```

---

### Gate 6 Warning: Empty Conversations

**Symptom**: Conversations with 0 messages

**Fix**: Usually acceptable (conversations created but no extractable messages)

**Investigation**:
```sql
-- Check empty conversations
SELECT c.id, c.lead_id, c.started_at, l.name
FROM "Conversation" c
JOIN "Lead" l ON c.lead_id = l.id
LEFT JOIN "Message" m ON c.id = m.conversation_id
GROUP BY c.id, c.lead_id, c.started_at, l.name
HAVING COUNT(m.id) = 0;

-- Check if audit records exist for these leads
SELECT action, COUNT(*)
FROM "Audit"
WHERE lead_id IN (SELECT lead_id FROM empty_conversations_above)
GROUP BY action;
```

---

### Gate 9 Failure: Multiple Open Conversations

**Symptom**: Lead has >1 open conversation

**Fix**: Close all but most recent
```sql
-- Find duplicates
SELECT lead_id, COUNT(*) as open_count
FROM "Conversation"
WHERE closed_at IS NULL
GROUP BY lead_id
HAVING COUNT(*) > 1;

-- Close older conversations
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY lead_id ORDER BY started_at DESC) as rn
  FROM "Conversation"
  WHERE closed_at IS NULL
)
UPDATE "Conversation"
SET closed_at = NOW()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
```

---

## Files

```
prisma/migrations/20251110_data_quality_gates/
├── validation.sql    # Comprehensive data quality checks
└── README.md         # This file
```

**Note**: No `migration.sql` or `rollback.sql` - this is a validation-only batch

---

## Pass Criteria

### Required (Must Pass)
- ✅ Gate 1: Lead coverage = 100%
- ✅ Gate 2: Job coverage = 100%
- ✅ Gate 3: No orphaned lead references
- ✅ Gate 4: No orphaned job references
- ✅ Gate 9: Max 1 open conversation per lead

### Informational (Review Only)
- ℹ️ Gate 5: Conversation coverage (expected: high %)
- ℹ️ Gate 6: Message presence (empty conversations acceptable)
- ℹ️ Gate 7: Random sampling (manual verification)
- ℹ️ Gate 8: Role distribution (should be balanced)
- ℹ️ Gate 10: Summary statistics (sanity check)
- ℹ️ Gate 11: Index usage (may be 0 initially)

---

## After Passing Gates

Once all required gates pass, you can:

1. **Tighten constraints** (make customer_id NOT NULL)
2. **Enable stricter validation** in application code
3. **Add additional foreign key constraints**
4. **Proceed with confidence** that data is clean and consistent

---

## Migration Safety

### Why This is Safe

1. **Read-only** - no data modifications
2. **No schema changes** - can't break anything
3. **Idempotent** - safe to run multiple times
4. **Fast** - validation queries are indexed

### Pre-flight Checks

Before running:
- [x] Ran Batches 1-5 successfully
- [x] Backfill scripts completed without errors
- [x] Context memory enabled in production

---

## Common Issues

### Issue: Slow Validation Queries

**Cause**: Missing indexes or table statistics out of date

**Fix**:
```sql
-- Update table statistics
ANALYZE "Customer";
ANALYZE "Lead";
ANALYZE "Job";
ANALYZE "Conversation";
ANALYZE "Message";
```

---

### Issue: Unexpected Data Counts

**Cause**: May indicate backfill script didn't run completely

**Fix**: Check backfill logs and re-run if needed
```bash
# Check Batch 3 (customer backfill)
npx tsx scripts/migrations/backfill-customers.ts --verbose

# Check Batch 4 (conversation/message backfill)
npx tsx scripts/migrations/backfill-conversations-messages.ts --verbose
```

---

## Monitoring

Run validation checks periodically to ensure data quality:

```bash
# Weekly quality check
psql "$DATABASE_URL" \
  -f prisma/migrations/20251110_data_quality_gates/validation.sql \
  > data_quality_$(date +%Y%m%d).log
```

---

## Summary

**Batch 6** validates data quality after backfills by:
- Checking 100% customer linkage for leads and jobs
- Validating foreign key integrity
- Confirming conversation and message presence
- Verifying constraint enforcement
- Providing data completeness statistics

**Risk**: None (read-only validation)
**Benefit**: Confidence in data quality before tightening constraints
**Reversibility**: N/A (no changes made)

---

**Ready to validate? This batch confirms all previous batches succeeded!**
