CREATE TABLE "AgentRuntimeState" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id" TEXT NOT NULL UNIQUE,
    "agent_paused" BOOLEAN NOT NULL DEFAULT FALSE,
    "updated_by" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
