-- Batch 5: Add Integrity Constraints and Operational Indexes
-- Prepares database for dual-write mode with safety constraints

-- ═══════════════════════════════════════════════════════════════
-- 0. ADD closed_at COLUMN (if not exists)
-- ═══════════════════════════════════════════════════════════════

-- Add closed_at column for conversation lifecycle tracking
ALTER TABLE "Conversation"
ADD COLUMN IF NOT EXISTS "closed_at" TIMESTAMPTZ;

-- ═══════════════════════════════════════════════════════════════
-- 1. PARTIAL UNIQUE INDEX: One Open Conversation Per Lead
-- ═══════════════════════════════════════════════════════════════

-- Ensures a lead can only have one active (non-closed) conversation at a time
-- This prevents duplicate open conversations when dual-write starts
CREATE UNIQUE INDEX IF NOT EXISTS "Conversation_lead_open_unique"
  ON "Conversation"(lead_id)
  WHERE closed_at IS NULL;

-- ═══════════════════════════════════════════════════════════════
-- 2. COMPOSITE RECENCY INDEXES for Query Performance
-- ═══════════════════════════════════════════════════════════════

-- Message recency by conversation (DESC for newest first)
-- Optimizes: "Get recent messages in a conversation"
CREATE INDEX IF NOT EXISTS "Message_conversation_id_created_at_idx"
  ON "Message"(conversation_id, created_at DESC);

-- Conversation recency by customer (DESC for newest first)
-- Optimizes: "Get customer's recent conversations"
CREATE INDEX IF NOT EXISTS "Conversation_customer_id_started_at_idx"
  ON "Conversation"(customer_id, started_at DESC);

-- ═══════════════════════════════════════════════════════════════
-- 3. ADDITIONAL OPERATIONAL INDEXES
-- ═══════════════════════════════════════════════════════════════

-- Customer lookup by phone (for fast customer identification)
-- Already exists from Batch 1, but verify
CREATE INDEX IF NOT EXISTS "Customer_phone_idx"
  ON "Customer"(phone)
  WHERE phone IS NOT NULL;

-- Customer lookup by email
-- Already exists from Batch 1, but verify
CREATE INDEX IF NOT EXISTS "Customer_email_idx"
  ON "Customer"(email)
  WHERE email IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════

-- Verify indexes exist
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'Conversation_lead_open_unique'
  ) THEN
    RAISE NOTICE '✓ Partial unique index created: Conversation_lead_open_unique';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'Message_conversation_id_created_at_idx'
  ) THEN
    RAISE NOTICE '✓ Composite index created: Message_conversation_id_created_at_idx';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'Conversation_customer_id_started_at_idx'
  ) THEN
    RAISE NOTICE '✓ Composite index created: Conversation_customer_id_started_at_idx';
  END IF;
END $$;
