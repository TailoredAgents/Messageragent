-- CreateEnum: MessageRole for context memory
CREATE TYPE "MessageRole" AS ENUM ('user', 'assistant', 'system', 'tool');

-- AlterTable: Add nullable customer_id to Lead
ALTER TABLE "Lead"
  ADD COLUMN "customer_id" UUID;

-- AlterTable: Add nullable customer_id to Job
ALTER TABLE "Job"
  ADD COLUMN "customer_id" UUID;

-- CreateTable: Customer
CREATE TABLE "Customer" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable: CustomerAddress
CREATE TABLE "CustomerAddress" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id" UUID NOT NULL,
  "address" TEXT NOT NULL,
  "city" TEXT,
  "state" TEXT,
  "zip" TEXT,
  "lat" DOUBLE PRECISION,
  "lng" DOUBLE PRECISION,
  "is_primary" BOOLEAN NOT NULL DEFAULT false,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerAddress_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable: Conversation
CREATE TABLE "Conversation" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id" UUID,
  "lead_id" UUID,
  "channel" "Channel" NOT NULL,
  "external_id" TEXT,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_message_at" TIMESTAMPTZ,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Conversation_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Conversation_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable: Message
CREATE TABLE "Message" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id" UUID NOT NULL,
  "role" "MessageRole" NOT NULL,
  "content" TEXT NOT NULL,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Message_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable: MemoryNote
CREATE TABLE "MemoryNote" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id" UUID,
  "conversation_id" UUID,
  "content" TEXT NOT NULL,
  "metadata" JSONB,
  "expires_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemoryNote_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable: JobItem
CREATE TABLE "JobItem" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "job_id" UUID NOT NULL,
  "description" TEXT NOT NULL,
  "quantity" DECIMAL(10,2) NOT NULL,
  "unit_price" DECIMAL(10,2) NOT NULL,
  "total" DECIMAL(10,2) NOT NULL,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JobItem_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable: JobEvent
CREATE TABLE "JobEvent" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "job_id" UUID NOT NULL,
  "event_type" TEXT NOT NULL,
  "actor" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JobEvent_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex: Customer lookups
CREATE INDEX "Customer_phone_idx" ON "Customer"("phone");
CREATE INDEX "Customer_email_idx" ON "Customer"("email");
CREATE INDEX "Customer_created_at_idx" ON "Customer"("created_at");

-- CreateIndex: CustomerAddress lookups
CREATE INDEX "CustomerAddress_customer_id_idx" ON "CustomerAddress"("customer_id");
CREATE INDEX "CustomerAddress_customer_id_is_primary_idx" ON "CustomerAddress"("customer_id", "is_primary");

-- CreateIndex: Conversation lookups
CREATE UNIQUE INDEX "Conversation_channel_external_id_key" ON "Conversation"("channel", "external_id");
CREATE INDEX "Conversation_customer_id_idx" ON "Conversation"("customer_id");
CREATE INDEX "Conversation_lead_id_idx" ON "Conversation"("lead_id");
CREATE INDEX "Conversation_last_message_at_idx" ON "Conversation"("last_message_at");
CREATE INDEX "Conversation_started_at_idx" ON "Conversation"("started_at");

-- CreateIndex: Message lookups
CREATE INDEX "Message_conversation_id_idx" ON "Message"("conversation_id");
CREATE INDEX "Message_conversation_id_created_at_idx" ON "Message"("conversation_id", "created_at");
CREATE INDEX "Message_created_at_idx" ON "Message"("created_at");

-- CreateIndex: MemoryNote lookups
CREATE INDEX "MemoryNote_customer_id_idx" ON "MemoryNote"("customer_id");
CREATE INDEX "MemoryNote_conversation_id_idx" ON "MemoryNote"("conversation_id");
CREATE INDEX "MemoryNote_created_at_idx" ON "MemoryNote"("created_at");
CREATE INDEX "MemoryNote_expires_at_idx" ON "MemoryNote"("expires_at");

-- CreateIndex: JobItem lookups
CREATE INDEX "JobItem_job_id_idx" ON "JobItem"("job_id");

-- CreateIndex: JobEvent lookups
CREATE INDEX "JobEvent_job_id_idx" ON "JobEvent"("job_id");
CREATE INDEX "JobEvent_job_id_created_at_idx" ON "JobEvent"("job_id", "created_at");
CREATE INDEX "JobEvent_event_type_idx" ON "JobEvent"("event_type");

-- CreateIndex: Lead.customer_id foreign key
CREATE INDEX "Lead_customer_id_idx" ON "Lead"("customer_id");

-- CreateIndex: Job.customer_id foreign key
CREATE INDEX "Job_customer_id_idx" ON "Job"("customer_id");

-- AddForeignKey: Lead -> Customer
ALTER TABLE "Lead"
  ADD CONSTRAINT "Lead_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: Job -> Customer
ALTER TABLE "Job"
  ADD CONSTRAINT "Job_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
