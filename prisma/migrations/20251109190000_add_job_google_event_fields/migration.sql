-- Add Google Calendar metadata columns to Job
ALTER TABLE "Job"
  ADD COLUMN "google_calendar_id" TEXT,
  ADD COLUMN "google_event_id" TEXT UNIQUE,
  ADD COLUMN "google_event_ical_uid" TEXT,
  ADD COLUMN "google_event_etag" TEXT,
  ADD COLUMN "google_event_html_link" TEXT;
