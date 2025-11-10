-- Batch 2: Add Full-Text Search (FTS) Index on Message.content
-- Enables fast keyword recall over message history using PostgreSQL's GIN index

-- Create GIN index for full-text search on message content
-- Uses 'english' dictionary for stemming and stop words
-- COALESCE handles NULL values gracefully
CREATE INDEX IF NOT EXISTS "Message_content_fts_idx"
  ON "Message"
  USING GIN (to_tsvector('english', COALESCE(content, '')));

-- Optional: Add index on role for filtered FTS queries
-- Useful for searching only user messages or only assistant messages
CREATE INDEX IF NOT EXISTS "Message_role_idx"
  ON "Message"(role);
