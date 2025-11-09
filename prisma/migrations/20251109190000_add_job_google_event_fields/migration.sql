-- Add Google Calendar metadata columns to Job
ALTER TABLE "Job"
  ADD COLUMN "google_calendar_id" TEXT,
  ADD COLUMN "google_event_id" TEXT UNIQUE,
  ADD COLUMN "google_event_ical_uid" TEXT,
  ADD COLUMN "google_event_etag" TEXT,
  ADD COLUMN "google_event_html_link" TEXT;

-- Track Google Calendar sync state
CREATE TABLE IF NOT EXISTS "CalendarSyncState" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "calendar_id" TEXT NOT NULL UNIQUE,
  "sync_token" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
