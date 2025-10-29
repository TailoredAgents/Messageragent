CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('messenger', 'sms');

-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM (
  'awaiting_photos',
  'clarifying',
  'quoting',
  'awaiting_owner',
  'scheduling',
  'booked',
  'reminding',
  'done'
);

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('draft', 'pending_approval', 'approved', 'denied', 'sent', 'accepted');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('tentative', 'booked', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'denied');

-- CreateTable
CREATE TABLE "Lead" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "channel" "Channel" NOT NULL,
    "name" TEXT,
    "messengerPsid" TEXT UNIQUE,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "curbside" BOOLEAN NOT NULL DEFAULT FALSE,
    "stage" "LeadStage" NOT NULL DEFAULT 'awaiting_photos',
    "stateMetadata" JSONB,
    "last_customer_message_at" TIMESTAMPTZ,
    "last_agent_message_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "lead_id" UUID NOT NULL REFERENCES "Lead"("id") ON DELETE CASCADE,
    "features_json" JSONB NOT NULL,
    "line_items_json" JSONB NOT NULL,
    "discounts_json" JSONB NOT NULL,
    "subtotal" NUMERIC(10, 2) NOT NULL,
    "total" NUMERIC(10, 2) NOT NULL,
    "confidence" NUMERIC(3, 2) NOT NULL,
    "needs_approval" BOOLEAN NOT NULL DEFAULT FALSE,
    "status" "QuoteStatus" NOT NULL DEFAULT 'draft',
    "flags_json" JSONB,
    "notes_json" JSONB,
    "disclaimer" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Job" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "lead_id" UUID NOT NULL REFERENCES "Lead"("id") ON DELETE CASCADE,
    "quote_id" UUID UNIQUE REFERENCES "Quote"("id") ON DELETE SET NULL,
    "window_start" TIMESTAMPTZ NOT NULL,
    "window_end" TIMESTAMPTZ NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'tentative',
    "reminder_scheduled_at" TIMESTAMPTZ,
    "reminder_sent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "quote_id" UUID NOT NULL REFERENCES "Quote"("id") ON DELETE CASCADE,
    "token" TEXT NOT NULL UNIQUE,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "approver" TEXT,
    "decided_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Audit" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "lead_id" UUID REFERENCES "Lead"("id") ON DELETE SET NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Config" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id" TEXT NOT NULL UNIQUE,
    "service_area" JSONB NOT NULL,
    "pricebook" JSONB NOT NULL,
    "reminder_hours" INTEGER[] NOT NULL,
    "quote_policy" JSONB NOT NULL,
    "channels" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX "lead_channel_idx" ON "Lead"("channel");
CREATE INDEX "lead_stage_idx" ON "Lead"("stage");
CREATE INDEX "quote_lead_idx" ON "Quote"("lead_id");
CREATE INDEX "quote_status_idx" ON "Quote"("status");
CREATE INDEX "job_lead_idx" ON "Job"("lead_id");
CREATE INDEX "job_window_start_idx" ON "Job"("window_start");
CREATE INDEX "job_status_idx" ON "Job"("status");
CREATE INDEX "approval_quote_idx" ON "Approval"("quote_id");
CREATE INDEX "approval_status_idx" ON "Approval"("status");
CREATE INDEX "audit_lead_idx" ON "Audit"("lead_id");
CREATE INDEX "audit_created_idx" ON "Audit"("created_at");
