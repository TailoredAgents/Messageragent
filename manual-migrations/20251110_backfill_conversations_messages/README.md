## Batch 4 — Backfill Conversations and Messages from Audit Logs

## Objective
Create historical Conversation and Message records from existing Audit logs to enable context memory and conversation recall.

## Status
- **Created**: 2025-11-10
- **Applied**: ❌ (Pending)
- **Validated**: ❌ (Pending)

---

## Overview

This batch performs **data migration** from Audit logs. It:
1. Creates one Conversation per Lead
2. Extracts messages from Audit records (actor: customer/agent)
3. Creates Message records with proper roles
4. Uses audit.id for idempotent upserts
5. Populates FTS-indexed message content

**Key Feature**: IDEMPOTENT - uses audit.id to prevent duplicates

---

## Logic

### 1. Conversation Creation
```typescript
One Conversation per Lead:
- conversationId: UUID (generated)
- leadId: Lead.id
- customerId: Lead.customerId
- channel: Lead.channel
- externalId: Lead.messengerPsid or Lead.phone
- startedAt: Lead.createdAt
- lastMessageAt: Latest message timestamp
- metadata: { source: 'audit_backfill', ... }
```

### 2. Message Extraction from Audits

**Filter Criteria**:
```sql
SELECT * FROM "Audit"
WHERE leadId IS NOT NULL
  AND actor IN ('customer', 'agent', 'user', 'assistant', 'system')
ORDER BY created_at ASC;
```

**Role Mapping**:
| Audit.actor | Message.role |
|-------------|--------------|
| `customer`, `user` | `user` |
| `agent`, `assistant` | `assistant` |
| `system` | `system` |
| `tool` | `tool` |

**Text Extraction Priority**:
1. `payload.text`
2. `payload.message`
3. `payload.content`
4. `payload.body` (for message_sent/received actions)
5. Compact JSON (max 1000 chars)

### 3. Idempotency via audit.id
```typescript
Message.metadata.auditId = Audit.id  // Unique key
// Prevents duplicate messages on re-run
```

---

## Files

```
scripts/migrations/
└── backfill-conversations-messages.ts   # Main backfill script

prisma/migrations/20251110_backfill_conversations_messages/
├── README.md                           # This file
└── rollback.sql                        # Emergency rollback
```

---

## Usage

### 1. Dry Run (Recommended)
```bash
npx tsx scripts/migrations/backfill-conversations-messages.ts --dry-run
```

**Preview Output**:
```
🚀 Starting Batch 4: Conversation & Message Backfill
   Mode: 🔍 DRY RUN

[1/4] Fetching audit records...
📊 Found 25 audit records with messages
🔗 Grouped into 3 leads with audit history

[2/4] Creating conversations for leads...
   [DRY RUN] Would create conversation for lead abc-123

[3/4] Creating messages from audit logs...
   [DRY RUN] Would create message from audit xyz-789 (Hello, I need...)

[4/4] Recording audit log...
   [DRY RUN] Would create audit log

═══════════════════════════════════════════════════════════
🔍 DRY RUN COMPLETE
═══════════════════════════════════════════════════════════

📊 Statistics:
   Conversations created:  3
   Conversations skipped:  0
   Messages created:       20
   Messages skipped:       5
   Audits processed:       25
   Audits skipped:         0
   Errors:                 0
```

### 2. Verbose Mode
```bash
npx tsx scripts/migrations/backfill-conversations-messages.ts --verbose
```

Shows detailed progress for each conversation and message.

### 3. Apply Backfill
```bash
npx tsx scripts/migrations/backfill-conversations-messages.ts
```

Writes data to database.

### 4. Re-run (Idempotent)
```bash
# Safe to run again - skips existing records
npx tsx scripts/migrations/backfill-conversations-messages.ts
```

---

## Validation

### Key Checks

**1. Conversation Count**
```sql
SELECT
  COUNT(*) as conversations,
  COUNT(*) FILTER (WHERE metadata->>'source' = 'audit_backfill') as backfilled
FROM "Conversation";
```
Expected: conversations ≈ number of leads

**2. Message Count**
```sql
SELECT
  COUNT(*) as messages,
  COUNT(*) FILTER (WHERE metadata->>'source' = 'audit_backfill') as backfilled,
  COUNT(DISTINCT conversation_id) as unique_conversations
FROM "Message";
```
Expected: messages > 0, unique_conversations ≈ leads with audits

**3. Conversation → Lead Mapping**
```sql
SELECT
  COUNT(*) as leads,
  COUNT(*) FILTER (WHERE id IN (
    SELECT lead_id FROM "Conversation" WHERE metadata->>'source' = 'audit_backfill'
  )) as leads_with_conversations
FROM "Lead";
```
Expected: High percentage (depends on audit history)

**4. Message Roles Distribution**
```sql
SELECT
  role,
  COUNT(*) as count,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) as percentage
FROM "Message"
WHERE metadata->>'source' = 'audit_backfill'
GROUP BY role
ORDER BY count DESC;
```
Expected: Mix of user/assistant roles

**5. FTS Index Usage**
```sql
EXPLAIN ANALYZE
SELECT * FROM "Message"
WHERE to_tsvector('english', COALESCE(content, ''))
      @@ plainto_tsquery('english', 'quote');
```
Expected: Uses Message_content_fts_idx

**6. Sample Audit → Message Mapping**
```sql
SELECT
  a.id as audit_id,
  a.actor as audit_actor,
  a.action,
  a.created_at,
  m.id as message_id,
  m.role,
  LEFT(m.content, 100) as content_preview
FROM "Audit" a
LEFT JOIN "Message" m ON m.metadata->>'auditId' = a.id::text
WHERE a.actor IN ('customer', 'agent')
  AND a.lead_id IS NOT NULL
LIMIT 10;
```
Expected: Each audit with customer/agent actor has corresponding message

---

## Expected Results

### Typical Dataset

| Metric | Example Value |
|--------|---------------|
| **Leads** | 3 |
| **Conversations Created** | 3 (one per lead) |
| **Audits with Messages** | 20-50 |
| **Messages Created** | 15-40 (some audits skipped) |
| **Execution Time** | 10-30 seconds |

### Message Distribution

| Role | Percentage |
|------|------------|
| **user** (customer) | 40-60% |
| **assistant** (agent) | 30-50% |
| **system** | 5-15% |
| **tool** | 0-5% |

---

## Rollback

```bash
psql "$DATABASE_URL" \
  -f prisma/migrations/20251110_backfill_conversations_messages/rollback.sql
```

**Actions**:
1. Deletes all backfilled Messages (`metadata.source = 'audit_backfill'`)
2. Deletes all backfilled Conversations (`metadata.source = 'audit_backfill'`)
3. Deletes backfill audit logs
4. Verifies deletion

**After rollback**, re-run script with fixes.

---

## Error Handling

### Common Issues

**1. No Extractable Text**
```
⊙ Skipping audit xyz-789 (no extractable text)
```
**Resolution**: Normal, some audits don't contain messages

**2. Lead Not Found**
```
⚠ Lead abc-123 not found, skipping
```
**Resolution**: Audit references deleted lead (orphaned), skip safely

**3. Conversation Already Exists**
```
⊙ Conversation already exists for lead abc-123
```
**Resolution**: Normal on re-run (idempotent behavior)

### Error Recovery

Errors logged in:
1. Script output (`stats.errors[]`)
2. Console warnings
3. Audit table payload

Fix errors and re-run (idempotent).

---

## Performance

### Small Dataset (< 100 audits)
- **Time**: 10-20 seconds
- **Memory**: < 100MB
- **Conversations**: 3-10
- **Messages**: 50-80

### Medium Dataset (100-1,000 audits)
- **Time**: 30-60 seconds
- **Memory**: 200-500MB
- **Conversations**: 10-50
- **Messages**: 500-800

### Large Dataset (> 1,000 audits)
- **Time**: 1-5 minutes
- **Memory**: 500MB-1GB
- **Conversations**: 50-200
- **Messages**: 5,000-8,000

**Optimization**: Processes in batches, uses upserts for efficiency.

---

## FTS Integration

### Automatic Indexing

All messages are automatically indexed by `Message_content_fts_idx` (from Batch 2).

**Test FTS Search**:
```sql
SELECT
  m.id,
  m.role,
  m.content,
  ts_rank(
    to_tsvector('english', COALESCE(m.content, '')),
    plainto_tsquery('english', 'quote')
  ) as relevance
FROM "Message" m
WHERE to_tsvector('english', COALESCE(m.content, ''))
      @@ plainto_tsquery('english', 'quote')
ORDER BY relevance DESC
LIMIT 10;
```

### Search Performance

With FTS index:
- **10 messages**: < 1ms
- **100 messages**: < 5ms
- **1,000 messages**: < 10ms
- **10,000 messages**: < 50ms

---

## Message Metadata

Each message includes:

```json
{
  "auditId": "audit-uuid",
  "auditAction": "message_sent",
  "auditActor": "customer",
  "source": "audit_backfill",
  "createdBy": "backfill-conversations-messages.ts"
}
```

**Use Cases**:
- Trace back to original audit
- Filter backfilled vs real-time messages
- Debugging and auditing

---

## Conversation Metadata

Each conversation includes:

```json
{
  "source": "audit_backfill",
  "leadStage": "done",
  "createdBy": "backfill-conversations-messages.ts",
  "createdAt": "2025-11-10T..."
}
```

---

## Next Steps (Batch 5+)

After Batch 4:
1. Validate conversation/message linking
2. Test FTS search with real queries
3. Backfill MemoryNote from stateMetadata (optional)
4. Enable `CONTEXT_MEMORY_ENABLED=true`
5. Test agent context recall

---

## Manual Operations

### View Conversation History
```sql
SELECT
  c.id,
  c.channel,
  c.started_at,
  COUNT(m.id) as message_count,
  MIN(m.created_at) as first_message,
  MAX(m.created_at) as last_message
FROM "Conversation" c
LEFT JOIN "Message" m ON m.conversation_id = c.id
GROUP BY c.id, c.channel, c.started_at
ORDER BY c.started_at DESC;
```

### Extract Conversation Thread
```sql
SELECT
  m.created_at,
  m.role,
  m.content
FROM "Message" m
WHERE m.conversation_id = 'conversation-uuid'
ORDER BY m.created_at ASC;
```

### Re-process Single Lead
```sql
-- Delete existing messages for a lead
DELETE FROM "Message"
WHERE conversation_id IN (
  SELECT id FROM "Conversation" WHERE lead_id = 'lead-uuid'
);

-- Delete conversation
DELETE FROM "Conversation" WHERE lead_id = 'lead-uuid';

-- Re-run script (will recreate for this lead)
```

---

## Troubleshooting

### No Messages Created

**Cause**: Audits don't match filter criteria (actor not in customer/agent/etc.)
**Fix**: Check audit data:
```sql
SELECT DISTINCT actor FROM "Audit" WHERE lead_id IS NOT NULL;
```

### Duplicate Messages

**Cause**: metadata.auditId not set correctly
**Fix**: Should not happen (script enforces uniqueness), but can rollback and re-run

### Slow Performance

**Cause**: Large audit table, many database roundtrips
**Fix**: Already optimized with bulk operations

---

## Testing

### Test on Staging
1. Copy production audits to staging
2. Run backfill on staging
3. Validate results
4. Apply to production

### Test Idempotency
```bash
# Run twice
npx tsx scripts/migrations/backfill-conversations-messages.ts
npx tsx scripts/migrations/backfill-conversations-messages.ts --verbose
```

Second run should show:
- 0 conversations created (all exist)
- 0 messages created (all exist via auditId)

---

## Migration Safety

### Why This is Safe

1. **No schema changes** - only data population
2. **Idempotent** - uses audit.id upserts
3. **Non-destructive** - doesn't modify audits
4. **Audited** - every run logged
5. **Rollback available** - can undo completely

### Pre-flight Checklist

- [ ] Ran Batch 1 (schema created)
- [ ] Ran Batch 2 (FTS indexes)
- [ ] Ran Batch 3 (customers linked)
- [ ] Tested dry run
- [ ] Reviewed audit data
- [ ] Database backup taken

---

**Remember**: Idempotent design means safe re-runs anytime!
