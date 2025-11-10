# Batch 3 — Customer Backfill and Lead/Job Linking

## Objective
Populate Customer table from existing Lead data and link all Lead and Job records to appropriate customers.

## Status
- **Created**: 2025-11-10
- **Applied**: ❌ (Pending)
- **Validated**: ❌ (Pending)

---

## Overview

This batch performs **data migration** (not schema changes). It:
1. Groups leads by customer identifiers
2. Creates Customer records for each group
3. Links Lead.customerId to Customer
4. Links Job.customerId via Lead relationship
5. Records backfill run in Audit table

**Key Feature**: IDEMPOTENT - safe to run multiple times

---

## Grouping Logic

Leads are grouped into customers using this priority:

### Priority 1: Messenger PSID (Most Reliable)
```
Lead.messengerPsid → Customer
```
- All leads with same PSID = same customer
- Most reliable for messenger channel
- Preserves conversation continuity

### Priority 2: Normalized Phone (Reliable)
```
normalize(Lead.phone) → Customer
```
- Removes non-digits, requires 10+ digits
- Groups SMS and phone-based leads
- `+1 (555) 123-4567` = `5551234567`

### Priority 3: Normalized Email (Conservative)
```
normalize(Lead.email) → Customer
```
- Lowercase, trimmed
- Conservative merge (skips risky overlaps)
- Requires valid email format

### Priority 4: Individual (Fallback)
```
Lead.id → Customer (1:1)
```
- One customer per lead
- Used when no grouping key available

---

## Script Features

### Idempotency
- Checks for existing customers before creating
- Skips already-linked leads/jobs
- Safe to run multiple times

### Conservative Merging
- Prioritizes reliable identifiers (PSID, phone)
- Email merging is conservative
- Avoids risky multi-customer merges

### Metadata Tracking
```json
{
  "groupType": "psid|phone|email|individual",
  "groupKey": "psid:12345...",
  "leadCount": 3,
  "createdBy": "backfill-customers.ts",
  "createdAt": "2025-11-10T...",
  "multipleLeads": true
}
```

### Audit Logging
Every run creates an Audit record with:
- Customers created
- Leads linked
- Jobs linked
- Errors encountered

---

## Files

```
scripts/migrations/
└── backfill-customers.ts   # Main backfill script (idempotent)

prisma/migrations/20251110_backfill_customers/
├── README.md               # This file
├── validation.sql          # Post-backfill validation queries
└── rollback.sql            # Emergency rollback procedure
```

---

## Usage

### 1. Dry Run (Recommended First)
```bash
npx tsx scripts/migrations/backfill-customers.ts --dry-run
```

**Output Preview**:
```
🚀 Starting Batch 3: Customer Backfill
   Mode: 🔍 DRY RUN

[1/4] Grouping leads by customer identifiers...
📊 Found 150 total leads
🔗 Grouped into 87 potential customers
   - By PSID: 45
   - By Phone: 30
   - By Email: 10
   - Individual: 2

[2/4] Creating customers and linking leads...
   [DRY RUN] Would create customer (psid, 3 leads)
   ...

[3/4] Linking jobs to customers...
   [DRY RUN] Would link 75 job(s)

[4/4] Recording audit log...
   [DRY RUN] Would create audit log

═══════════════════════════════════════════════════════════
🔍 DRY RUN COMPLETE
═══════════════════════════════════════════════════════════

📊 Statistics:
   Customers created:      87
   Customers reused:       0
   Leads linked:           150
   Leads already linked:   0
   Jobs linked:            75
   Jobs already linked:    0
   Errors:                 0
```

### 2. Verbose Mode (More Details)
```bash
npx tsx scripts/migrations/backfill-customers.ts --dry-run --verbose
```

Shows detailed progress for each customer group.

### 3. Apply Backfill (Real Run)
```bash
npx tsx scripts/migrations/backfill-customers.ts
```

**Without** `--dry-run`, writes data to database.

### 4. Re-run (Idempotent)
```bash
# Safe to run again - will skip already-linked records
npx tsx scripts/migrations/backfill-customers.ts
```

---

## Validation

After running backfill, validate with SQL queries:

```bash
psql "$DATABASE_URL" -f prisma/migrations/20251110_backfill_customers/validation.sql
```

### Key Validation Checks

1. **Customer Count**
   ```sql
   SELECT COUNT(*) FROM "Customer";
   -- Expected: > 0
   ```

2. **Lead Linkage (Should be 100%)**
   ```sql
   SELECT COUNT(*) FROM "Lead" WHERE customer_id IS NULL;
   -- Expected: 0 or very few
   ```

3. **Job Linkage (Should be 100%)**
   ```sql
   SELECT COUNT(*) FROM "Job" WHERE customer_id IS NULL;
   -- Expected: 0
   ```

4. **Integrity Check**
   ```sql
   SELECT COUNT(*) FROM "Job" j
   INNER JOIN "Lead" l ON j.lead_id = l.id
   WHERE j.customer_id != l.customer_id;
   -- Expected: 0 (jobs must match lead's customer)
   ```

5. **Audit Log**
   ```sql
   SELECT * FROM "Audit"
   WHERE action = 'backfill_customers'
   ORDER BY created_at DESC
   LIMIT 1;
   -- Expected: Recent backfill entry with stats
   ```

---

## Expected Results

### For Typical Dataset

| Metric | Example Value |
|--------|---------------|
| **Total Leads** | 150 |
| **Customers Created** | 80-100 |
| **Avg Leads per Customer** | 1.5-2.0 |
| **Jobs Linked** | 75 |
| **Execution Time** | 5-30 seconds |

### Grouping Distribution

| Group Type | Percentage |
|------------|------------|
| **PSID** | 50-60% (messenger leads) |
| **Phone** | 30-40% (SMS leads) |
| **Email** | 5-10% (email-only leads) |
| **Individual** | 1-5% (no identifier) |

---

## Rollback

If backfill needs to be reversed:

```bash
psql "$DATABASE_URL" -f prisma/migrations/20251110_backfill_customers/rollback.sql
```

**Warning**: This will:
- Unlink all jobs from customers (`customer_id = NULL`)
- Unlink all leads from customers (`customer_id = NULL`)
- Delete all backfilled Customer records
- Delete CustomerAddress records
- Delete backfill audit logs

**After rollback**, you can fix the script and re-run:
```bash
npx tsx scripts/migrations/backfill-customers.ts --dry-run
npx tsx scripts/migrations/backfill-customers.ts
```

---

## Error Handling

### Common Errors

**1. Duplicate Phone Numbers**
```
Error: Unique constraint failed on Customer.phone
```
**Fix**: Script handles this by finding existing customer first

**2. Invalid Lead References**
```
Error: Foreign key constraint failed
```
**Fix**: Script verifies Lead/Job relationships before linking

**3. Missing Lead Data**
```
Warning: Lead has no grouping key
```
**Fix**: Creates individual customer (1:1 mapping)

### Error Recovery

Errors are logged in:
1. Script output (`stats.errors[]`)
2. Audit table (`payload.stats.errors`)

Fix errors and re-run (idempotent).

---

## Performance

### Small Dataset (< 1,000 leads)
- **Time**: 5-10 seconds
- **Customers**: 500-700
- **Memory**: < 100MB

### Medium Dataset (1,000-10,000 leads)
- **Time**: 30-60 seconds
- **Customers**: 5,000-7,000
- **Memory**: 200-500MB

### Large Dataset (> 10,000 leads)
- **Time**: 1-5 minutes
- **Customers**: 50,000-70,000
- **Memory**: 500MB-1GB

**Optimization**: Script processes in single transaction for consistency.

---

## Data Quality Checks

### After Backfill

1. **Check for NULL customer_id**
   ```sql
   SELECT COUNT(*) FROM "Lead" WHERE customer_id IS NULL;
   ```

2. **Check merge quality**
   ```sql
   SELECT
     c.id,
     COUNT(l.id) as lead_count,
     c.metadata->>'groupType' as type
   FROM "Customer" c
   INNER JOIN "Lead" l ON l.customer_id = c.id
   GROUP BY c.id
   HAVING COUNT(l.id) > 5;  -- Unusually high merges
   ```

3. **Check for duplicate contacts**
   ```sql
   SELECT phone, COUNT(*) FROM "Customer"
   WHERE phone IS NOT NULL
   GROUP BY phone
   HAVING COUNT(*) > 1;
   ```

---

## Manual Adjustments

### Merge Two Customers

```sql
-- Merge customer2 into customer1
UPDATE "Lead"
SET customer_id = 'customer1-uuid'
WHERE customer_id = 'customer2-uuid';

UPDATE "Job"
SET customer_id = 'customer1-uuid'
WHERE customer_id = 'customer2-uuid';

DELETE FROM "Customer"
WHERE id = 'customer2-uuid';
```

### Split Customer

```sql
-- Create new customer
INSERT INTO "Customer" (id, name, phone, email, metadata)
VALUES (gen_random_uuid(), 'Name', '5551234567', 'email@example.com', '{}');

-- Move specific leads
UPDATE "Lead"
SET customer_id = 'new-customer-uuid'
WHERE id IN ('lead1-uuid', 'lead2-uuid');

-- Move related jobs
UPDATE "Job"
SET customer_id = 'new-customer-uuid'
WHERE lead_id IN ('lead1-uuid', 'lead2-uuid');
```

---

## Next Steps (Batch 4)

After Batch 3 completes:
1. Validate customer linkage (100% expected)
2. Backfill Conversation/Message tables
3. Migrate stateMetadata → Message records
4. Enable `CONTEXT_MEMORY_ENABLED=true`

---

## Troubleshooting

### Script Won't Run

**Error**: `Cannot find module '@prisma/client'`
**Fix**:
```bash
npm install
npx prisma generate
```

### Slow Performance

**Cause**: Large dataset, many database roundtrips
**Fix**: Already optimized with batch operations

### Unexpected Merges

**Cause**: Shared phone/email between distinct customers
**Fix**:
1. Review `validation.sql` grouping checks
2. Manually split customers if needed
3. Adjust grouping logic in script

---

## Testing

### Test on Staging First

1. Copy production data to staging
2. Run backfill on staging
3. Validate results
4. Apply to production

### Test Idempotency

```bash
# Run twice, results should be identical
npx tsx scripts/migrations/backfill-customers.ts
npx tsx scripts/migrations/backfill-customers.ts --verbose
```

Second run should show:
- 0 customers created
- 0 leads linked (all already linked)

---

## Migration Safety

### Why This is Safe

1. **No schema changes** - only data population
2. **Nullable FKs** - Lead/Job can have NULL customer_id
3. **Idempotent** - safe to re-run
4. **Audited** - every run logged
5. **Rollback available** - can undo completely

### Pre-flight Checklist

- [ ] Ran Batch 1 (schema created)
- [ ] Ran Batch 2 (FTS indexes)
- [ ] Tested dry run
- [ ] Reviewed grouping logic
- [ ] Database backup taken
- [ ] Staging tested (if available)

---

## Support

If issues occur:
1. Check script output for errors
2. Review Audit table entries
3. Run validation.sql queries
4. Check rollback.sql if needed
5. Re-run with `--verbose` for details

**Remember**: Idempotent design means you can always re-run safely!
