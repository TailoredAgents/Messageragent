-- Safe migration: add LeadAttachment table compatible with existing UUID schema

CREATE TABLE IF NOT EXISTS "LeadAttachment" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "lead_id" UUID NOT NULL REFERENCES "Lead"("id") ON DELETE CASCADE,
    "url" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Uniqueness per lead+url to dedupe
CREATE UNIQUE INDEX IF NOT EXISTS "LeadAttachment_lead_id_url_key" ON "LeadAttachment"("lead_id", "url");

-- Recent-first lookup index
CREATE INDEX IF NOT EXISTS "LeadAttachment_lead_id_created_at_idx" ON "LeadAttachment"("lead_id", "created_at");
