# Batch 7 — Tighten Constraints

## Objective
Enforce required customer relationships now that data is complete (100% coverage verified by Batch 6) and dual-write is active.

## Status
- **Created**: 2025-11-10
- **Applied**: ❌ (Pending)
- **Validated**: ❌ (Pending)

---

## Overview

This batch **tightens database constraints** by making `customer_id` NOT NULL on both Lead and Job tables. This is now safe because:

1. ✅ Batch 6 validated 100% coverage (0 NULL customer_id values)
2. ✅ Batch 3 backfill linked all existing records
3. ✅ Context memory system is active (dual-write mode)
4. ✅ Application creates customers before leads/jobs

**Key Feature**: Database-level enforcement of customer relationships

---

## Changes

### 1. Make Lead.customer_id NOT NULL

```sql
ALTER TABLE "Lead"
ALTER COLUMN customer_id SET NOT NULL;
```

**Purpose**: Every lead MUST be associated with a customer

**Impact**:
- ✅ **Enforced**: New leads require customer_id
- ❌ **Rejected**: INSERT/UPDATE without customer_id fails
- ✅ **Application**: Must create or fetch customer before lead

---

### 2. Make Job.customer_id NOT NULL

```sql
ALTER TABLE "Job"
ALTER COLUMN customer_id SET NOT NULL;
```

**Purpose**: Every job MUST be associated with a customer

**Impact**:
- ✅ **Enforced**: New jobs require customer_id
- ❌ **Rejected**: INSERT/UPDATE without customer_id fails
- ✅ **Application**: Must create or fetch customer before job

---

## Pre-flight Checks

The migration includes automatic validation:

```sql
-- Checks for NULL values before applying constraints
SELECT COUNT(*) FROM "Lead" WHERE customer_id IS NULL;  -- Must be 0
SELECT COUNT(*) FROM "Job" WHERE customer_id IS NULL;   -- Must be 0
```

**If any NULL values found**: Migration fails with error message

**Required**: Run Batch 3 backfill before Batch 7

---

## Usage

### Apply Migration

```bash
export DATABASE_URL="postgresql://..."

# Apply constraints
psql "$DATABASE_URL" \
  -f prisma/migrations/20251110_tighten_constraints/migration.sql
```

### Expected Output

```
NOTICE: ✓ Pre-flight check passed: All leads and jobs have customer_id
NOTICE: ✓ Lead.customer_id is now NOT NULL
NOTICE: ✓ Job.customer_id is now NOT NULL
NOTICE: ✓ Verification passed: Both constraints in place

=== Batch 7 Migration Complete ===

Changes applied:
  ✓ Lead.customer_id SET NOT NULL
  ✓ Job.customer_id SET NOT NULL

Impact:
  - New leads MUST have customer_id
  - New jobs MUST have customer_id
  - Database enforces customer relationship
```

---

### Validate Constraints

```bash
psql "$DATABASE_URL" \
  -f prisma/migrations/20251110_tighten_constraints/validation.sql
```

### Expected Validation Output

```
=== TEST 1: Verify NOT NULL Constraints ===
✓ PASS: NOT NULL enforced (both tables)

=== TEST 2: Reject Lead Without customer_id ===
✓ PASS: Lead insertion rejected (constraint working)

=== TEST 3: Reject Job Without customer_id ===
✓ PASS: Job insertion rejected (constraint working)

=== TEST 4: Allow Lead WITH customer_id ===
✓ PASS: Lead with customer_id inserted successfully

=== TEST 5: Allow Job WITH customer_id ===
✓ PASS: Job with customer_id inserted successfully

=== TEST 6: Reject UPDATE to NULL customer_id ===
✓ PASS: UPDATE to NULL rejected (constraint working)

=== TEST 7: Verify Existing Data Integrity ===
✓ PASS: All existing records have customer_id
```

---

### Rollback (If Needed)

```bash
psql "$DATABASE_URL" \
  -f prisma/migrations/20251110_tighten_constraints/rollback.sql
```

**Warning**: Only rollback if absolutely necessary. This removes data integrity enforcement.

---

## Application Impact

### Before Batch 7 (Nullable)

```typescript
// ⚠️ RISKY: Lead could be created without customer
const lead = await prisma.lead.create({
  data: {
    channel: 'messenger',
    name: 'Customer Name',
    // customer_id: undefined  <- No error, but bad practice
  },
});
```

---

### After Batch 7 (NOT NULL)

```typescript
// ✅ REQUIRED: Must provide customer_id
const customer = await prisma.customer.create({
  data: { name: 'Customer Name', metadata: {} },
});

const lead = await prisma.lead.create({
  data: {
    channel: 'messenger',
    customerId: customer.id,  // <- REQUIRED
    name: customer.name,
  },
});

// ❌ REJECTED: Without customer_id
const badLead = await prisma.lead.create({
  data: {
    channel: 'messenger',
    name: 'Customer Name',
    // Missing customerId -> Database rejects!
  },
});
// Error: null value in column "customer_id" violates not-null constraint
```

---

## Files

```
prisma/migrations/20251110_tighten_constraints/
├── migration.sql     # Applies NOT NULL constraints
├── rollback.sql      # Removes NOT NULL constraints
├── validation.sql    # Tests constraint enforcement
└── README.md         # This file
```

---

## Migration Safety

### Why This is Safe

1. **Data validated**: Batch 6 confirmed 100% coverage (0 NULL values)
2. **Pre-flight checks**: Migration fails if any NULL values exist
3. **Application ready**: Dual-write mode already creating customers first
4. **Reversible**: Can rollback if needed (though not recommended)

### Pre-flight Checks Required

Before applying:
- [x] Ran Batches 1-5 successfully
- [x] Ran Batch 6 validation (all gates passed)
- [x] Verified 0 NULL customer_id in Lead table
- [x] Verified 0 NULL customer_id in Job table
- [x] Application code creates customers before leads/jobs

---

## Error Scenarios

### Error 1: Migration Fails (NULL values found)

**Error**:
```
ERROR: Cannot tighten constraints: 2 leads have NULL customer_id
```

**Cause**: Batch 3 backfill not run or incomplete

**Fix**: Run Batch 3 backfill script
```bash
npx tsx scripts/migrations/backfill-customers.ts --verbose
```

Then re-run Batch 7.

---

### Error 2: Application Attempts Insert Without customer_id

**Error**:
```
PostgresError: null value in column "customer_id" violates not-null constraint
```

**Cause**: Application code trying to create lead/job without customer_id

**Fix**: Update application code to create customer first
```typescript
// BEFORE (broken after Batch 7)
await prisma.lead.create({ data: { channel, name } });

// AFTER (correct)
const customer = await prisma.customer.upsert({
  where: { phone: normalizedPhone },
  update: {},
  create: { phone: normalizedPhone, name },
});
await prisma.lead.create({
  data: { channel, customerId: customer.id, name },
});
```

---

### Error 3: Update Attempts to Set customer_id to NULL

**Error**:
```
PostgresError: null value in column "customer_id" violates not-null constraint
```

**Cause**: Application trying to remove customer relationship

**Fix**: Don't set customer_id to NULL. If customer changes, update to new customer:
```typescript
// WRONG
await prisma.lead.update({
  where: { id: leadId },
  data: { customerId: null },  // <- Rejected!
});

// RIGHT
await prisma.lead.update({
  where: { id: leadId },
  data: { customerId: newCustomerId },  // <- Update to different customer
});
```

---

## Testing

### Test 1: Verify Constraint Exists

```sql
SELECT
  column_name,
  is_nullable
FROM information_schema.columns
WHERE table_name = 'Lead' AND column_name = 'customer_id';

-- Expected: is_nullable = 'NO'
```

---

### Test 2: Attempt Invalid Insert

```sql
-- Should FAIL
INSERT INTO "Lead" (id, channel, name)
VALUES (gen_random_uuid(), 'messenger', 'Test');

-- Expected error: null value in column "customer_id" violates not-null constraint
```

---

### Test 3: Attempt Valid Insert

```sql
-- Should SUCCEED
INSERT INTO "Lead" (id, channel, customer_id, name)
VALUES (
  gen_random_uuid(),
  'messenger',
  (SELECT id FROM "Customer" LIMIT 1),
  'Test'
);
```

---

## Rollback Impact

### If Rollback Executed

**Impacts**:
- ❌ Leads can be created without customer_id again
- ❌ Jobs can be created without customer_id again
- ❌ No database-level enforcement of relationships
- ✅ Application must handle NULL customer_id
- ✅ Existing data unchanged (still has customer_id values)

**When to Rollback**:
- Application not ready for strict enforcement
- Need to support legacy data import without customers
- Emergency: constraint causing production issues

**Recovery**:
1. Fix application code or data issues
2. Re-run Batch 6 validation to confirm 100% coverage
3. Re-apply Batch 7 when ready

---

## Prisma Schema Update

After applying this migration, update `schema.prisma` to reflect the constraints:

```prisma
model Lead {
  id                       String      @id @default(uuid())
  channel                  Channel
  customerId               String      @map("customer_id")  // Remove '?' to make required
  // ... rest of fields

  customer                 Customer    @relation(fields: [customerId], references: [id], onDelete: Restrict)
  // ... rest of relations
}

model Job {
  id                 String     @id @default(uuid())
  leadId             String     @map("lead_id")
  customerId         String     @map("customer_id")  // Remove '?' to make required
  // ... rest of fields

  customer  Customer @relation(fields: [customerId], references: [id], onDelete: Restrict)
  // ... rest of relations
}
```

Then regenerate Prisma client:
```bash
npx prisma generate
```

---

## Performance Impact

### Write Performance
- **Minimal impact**: NOT NULL constraint check is very fast (O(1))
- **Slightly faster**: Database can optimize queries knowing column is never NULL

### Query Performance
- **No change**: NOT NULL doesn't affect index usage
- **Slight improvement**: Query planner can make better assumptions

### Storage
- **No change**: NOT NULL is a metadata flag, no storage impact

---

## Monitoring

After applying Batch 7, monitor for:

### Application Errors
```bash
# Check logs for constraint violations
grep "violates not-null constraint" application.log

# Expected: 0 errors (if application is ready)
```

### Database Constraint Checks
```sql
-- Weekly validation
SELECT
  COUNT(*) FILTER (WHERE customer_id IS NULL) as leads_without_customer,
  COUNT(*) FILTER (WHERE customer_id IS NOT NULL) as leads_with_customer
FROM "Lead";

-- Expected: leads_without_customer = 0 (enforced by constraint)
```

---

## Migration Timeline

| Time | Action | Result |
|------|--------|--------|
| T+0s | Pre-flight check | Validates 0 NULL values |
| T+1s | ALTER Lead | customer_id NOT NULL |
| T+2s | ALTER Job | customer_id NOT NULL |
| T+3s | Verification | Confirms constraints in place |
| T+5s | Complete | Migration done, constraints active |

**Total downtime**: None (DDL operation, very fast)
**Blocking**: Minimal (milliseconds per table)

---

## Summary

**Batch 7** tightens database constraints by:
- Making Lead.customer_id NOT NULL
- Making Job.customer_id NOT NULL
- Enforcing customer relationships at database level
- Preventing orphaned leads/jobs

**Risk**: Very low (data validated, application ready)
**Benefit**: High (data integrity enforced)
**Reversibility**: Complete (can rollback if needed)

**Prerequisites**:
- ✅ Batch 1-6 completed successfully
- ✅ 100% data coverage validated
- ✅ Application creates customers before leads/jobs

---

**Ready to apply? This enforces customer relationships at the database level!**
