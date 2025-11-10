# Batch 1 — Additive Schema (New Entities, Nullable Links)

## Objective
Introduce context memory entities and nullable customer foreign keys without impacting existing traffic.

## Status
- **Created**: 2025-11-10
- **Applied**: ❌ (Pending)
- **Validated**: ❌ (Pending)

## Schema Changes

### New Enums
- `MessageRole`: `user`, `assistant`, `system`, `tool`

### New Tables
1. **Customer** - Central customer entity
   - Primary key: `id` (UUID)
   - Fields: `name`, `phone`, `email`, `metadata` (JSONB)
   - Indexes: `phone`, `email`, `created_at`

2. **CustomerAddress** - Customer addresses (multi-address support)
   - Foreign key: `customer_id` → `Customer(id)` ON DELETE CASCADE
   - Fields: `address`, `city`, `state`, `zip`, `lat`, `lng`, `is_primary`
   - Indexes: `customer_id`, `(customer_id, is_primary)`

3. **Conversation** - Message threads per channel
   - Foreign keys:
     - `customer_id` → `Customer(id)` ON DELETE SET NULL
     - `lead_id` → `Lead(id)` ON DELETE SET NULL
   - Fields: `channel`, `external_id`, `started_at`, `last_message_at`, `metadata`
   - Unique constraint: `(channel, external_id)`
   - Indexes: `customer_id`, `lead_id`, `last_message_at`, `started_at`

4. **Message** - Individual messages in conversations
   - Foreign key: `conversation_id` → `Conversation(id)` ON DELETE CASCADE
   - Fields: `role` (MessageRole enum), `content` (TEXT), `metadata`
   - Indexes: `conversation_id`, `(conversation_id, created_at)`, `created_at`

5. **MemoryNote** - Persistent memory notes about customers
   - Foreign key: `customer_id` → `Customer(id)` ON DELETE CASCADE
   - Fields: `conversation_id`, `content`, `metadata`, `expires_at`
   - Indexes: `customer_id`, `conversation_id`, `created_at`, `expires_at`

6. **JobItem** - Line items for jobs
   - Foreign key: `job_id` → `Job(id)` ON DELETE CASCADE
   - Fields: `description`, `quantity`, `unit_price`, `total`, `metadata`
   - Indexes: `job_id`

7. **JobEvent** - Audit trail for job lifecycle events
   - Foreign key: `job_id` → `Job(id)` ON DELETE CASCADE
   - Fields: `event_type`, `actor`, `metadata`
   - Indexes: `job_id`, `(job_id, created_at)`, `event_type`

### Modified Tables
1. **Lead**
   - Added: `customer_id` (TEXT, nullable)
   - Foreign key: `customer_id` → `Customer(id)` ON DELETE SET NULL
   - Index: `customer_id`
   - Relation: `conversations` (1:many to Conversation)

2. **Job**
   - Added: `customer_id` (TEXT, nullable)
   - Foreign key: `customer_id` → `Customer(id)` ON DELETE SET NULL
   - Index: `customer_id`
   - Relations: `items` (1:many to JobItem), `events` (1:many to JobEvent)

## Foreign Key Delete Actions
- **RESTRICT**: Customer deletion blocked if related records exist
- **SET NULL**: Lead/Conversation customer reference nullified on Customer deletion (soft unlink)
- **CASCADE**: Dependent records (Address, Message, JobItem, JobEvent) deleted with parent

## Files
- `migration.sql` - Forward migration (apply this)
- `validation.sql` - Post-migration validation queries
- `rollback.sql` - Reverse migration (emergency use only)

## Pre-Migration Checklist
- [ ] Backup database (logical dump + snapshot)
- [ ] Verify `CONTEXT_MEMORY_ENABLED=false` in app environment
- [ ] Test backup restore procedure on staging
- [ ] Review migration SQL for syntax errors
- [ ] Confirm database connection string

## Apply Migration

### Option 1: Using Prisma (Recommended)
```bash
export DATABASE_URL="postgresql://junkquote_db_user:...@dpg-.../junkquote_db"
npx prisma migrate deploy
```

### Option 2: Direct SQL
```bash
psql $DATABASE_URL -f prisma/migrations/20251110_add_memory_entities/migration.sql
```

## Validation

Run validation queries:
```bash
psql $DATABASE_URL -f prisma/migrations/20251110_add_memory_entities/validation.sql
```

Expected results documented in `validation.sql`.

## Rollback

**⚠️ WARNING**: Only run rollback if you need to completely reverse this migration.

```bash
psql $DATABASE_URL -f prisma/migrations/20251110_add_memory_entities/rollback.sql
```

This will:
- Drop all new tables (Customer, CustomerAddress, Conversation, Message, MemoryNote, JobItem, JobEvent)
- Remove customer_id columns from Lead and Job
- Drop MessageRole enum
- **Data loss**: All customer and conversation data will be permanently deleted

## Post-Migration
- [ ] Verify all validation queries pass
- [ ] Check application logs for errors
- [ ] Monitor query performance on new indexes
- [ ] Keep `CONTEXT_MEMORY_ENABLED=false` until Batch 2 backfills complete

## Next Steps (Batch 2)
After Batch 1 is validated:
- Backfill customer_id on existing Lead/Job records
- Migrate existing Audit/stateMetadata to Conversation/Message tables
- Add NOT NULL constraints after backfill completes
