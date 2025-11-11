-- ═══════════════════════════════════════════════════════════════
-- Batch 6: Data Quality Gates
-- Validates backfill completeness before constraint tightening
-- ═══════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════
-- GATE 1: Lead Coverage (100% Required)
-- ═══════════════════════════════════════════════════════════════

\echo '=== GATE 1: Lead Coverage ==='
\echo ''

-- Check: All leads must have customer_id
SELECT
  COUNT(*) as unlinked_leads,
  CASE
    WHEN COUNT(*) = 0 THEN '✓ PASS: All leads linked to customers'
    ELSE '✗ FAIL: ' || COUNT(*) || ' leads missing customer_id'
  END as result
FROM "Lead"
WHERE customer_id IS NULL;

-- Show any unlinked leads (should be empty)
SELECT
  id,
  name,
  phone,
  email,
  "messengerPsid" as psid,
  created_at
FROM "Lead"
WHERE customer_id IS NULL
ORDER BY created_at DESC;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- GATE 2: Job Coverage (100% Required)
-- ═══════════════════════════════════════════════════════════════

\echo '=== GATE 2: Job Coverage ==='
\echo ''

-- Check: All jobs must have customer_id
SELECT
  COUNT(*) as unlinked_jobs,
  CASE
    WHEN COUNT(*) = 0 THEN '✓ PASS: All jobs linked to customers'
    ELSE '✗ FAIL: ' || COUNT(*) || ' jobs missing customer_id'
  END as result
FROM "Job"
WHERE customer_id IS NULL;

-- Show any unlinked jobs (should be empty)
SELECT
  j.id,
  j.lead_id,
  j.window_start,
  j.status,
  l.name as lead_name
FROM "Job" j
LEFT JOIN "Lead" l ON j.lead_id = l.id
WHERE j.customer_id IS NULL
ORDER BY j.window_start DESC;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- GATE 3: Customer-Lead Consistency
-- ═══════════════════════════════════════════════════════════════

\echo '=== GATE 3: Customer-Lead Consistency ==='
\echo ''

-- Check: Lead.customer_id must point to valid Customer
SELECT
  COUNT(*) as orphaned_leads,
  CASE
    WHEN COUNT(*) = 0 THEN '✓ PASS: All lead.customer_id valid'
    ELSE '✗ FAIL: ' || COUNT(*) || ' leads point to missing customers'
  END as result
FROM "Lead" l
LEFT JOIN "Customer" c ON l.customer_id = c.id
WHERE l.customer_id IS NOT NULL
  AND c.id IS NULL;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- GATE 4: Customer-Job Consistency
-- ═══════════════════════════════════════════════════════════════

\echo '=== GATE 4: Customer-Job Consistency ==='
\echo ''

-- Check: Job.customer_id must point to valid Customer
SELECT
  COUNT(*) as orphaned_jobs,
  CASE
    WHEN COUNT(*) = 0 THEN '✓ PASS: All job.customer_id valid'
    ELSE '✗ FAIL: ' || COUNT(*) || ' jobs point to missing customers'
  END as result
FROM "Job" j
LEFT JOIN "Customer" c ON j.customer_id = c.id
WHERE j.customer_id IS NOT NULL
  AND c.id IS NULL;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- GATE 5: Conversation Coverage
-- ═══════════════════════════════════════════════════════════════

\echo '=== GATE 5: Conversation Coverage ==='
\echo ''

-- Check: All leads with messages should have conversations
SELECT
  COUNT(DISTINCT l.id) as leads_with_history,
  COUNT(DISTINCT c.lead_id) as leads_with_conversations,
  CASE
    WHEN COUNT(DISTINCT l.id) = COUNT(DISTINCT c.lead_id)
    THEN '✓ PASS: All leads with history have conversations'
    ELSE '✗ WARNING: ' || (COUNT(DISTINCT l.id) - COUNT(DISTINCT c.lead_id)) || ' leads missing conversations'
  END as result
FROM "Lead" l
LEFT JOIN "Conversation" c ON l.id = c.lead_id
WHERE EXISTS (
  SELECT 1 FROM "Audit" a WHERE a.lead_id = l.id
);

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- GATE 6: Message History Presence
-- ═══════════════════════════════════════════════════════════════

\echo '=== GATE 6: Message History Presence ==='
\echo ''

-- Check: Conversations should have messages
SELECT
  COUNT(*) as conversations_total,
  COUNT(*) FILTER (WHERE message_count > 0) as conversations_with_messages,
  COUNT(*) FILTER (WHERE message_count = 0) as conversations_empty,
  CASE
    WHEN COUNT(*) FILTER (WHERE message_count = 0) = 0
    THEN '✓ PASS: All conversations have messages'
    ELSE '✗ WARNING: ' || COUNT(*) FILTER (WHERE message_count = 0) || ' empty conversations'
  END as result
FROM (
  SELECT
    c.id,
    COUNT(m.id) as message_count
  FROM "Conversation" c
  LEFT JOIN "Message" m ON c.id = m.conversation_id
  GROUP BY c.id
) conv_messages;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- GATE 7: Random Sampling - Customer Linkage Accuracy
-- ═══════════════════════════════════════════════════════════════

\echo '=== GATE 7: Random Sampling - Customer Linkage ==='
\echo ''

-- Sample 3 customers with their leads
SELECT
  c.id as customer_id,
  c.name as customer_name,
  c.phone as customer_phone,
  c.email as customer_email,
  COUNT(DISTINCT l.id) as lead_count,
  COUNT(DISTINCT j.id) as job_count,
  COUNT(DISTINCT conv.id) as conversation_count,
  STRING_AGG(DISTINCT l."messengerPsid", ', ') as psids
FROM "Customer" c
LEFT JOIN "Lead" l ON c.id = l.customer_id
LEFT JOIN "Job" j ON c.id = j.customer_id
LEFT JOIN "Conversation" conv ON c.id = conv.customer_id
GROUP BY c.id, c.name, c.phone, c.email
ORDER BY c.created_at
LIMIT 3;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- GATE 8: Message Role Distribution
-- ═══════════════════════════════════════════════════════════════

\echo '=== GATE 8: Message Role Distribution ==='
\echo ''

-- Check: Messages should have balanced user/assistant roles
SELECT
  role,
  COUNT(*) as message_count,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) as percentage,
  AVG(LENGTH(content)) as avg_content_length
FROM "Message"
GROUP BY role
ORDER BY message_count DESC;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- GATE 9: Conversation Integrity
-- ═══════════════════════════════════════════════════════════════

\echo '=== GATE 9: Conversation Integrity ==='
\echo ''

-- Check: Open conversations constraint
SELECT
  lead_id,
  COUNT(*) as open_conversation_count,
  CASE
    WHEN COUNT(*) = 1 THEN '✓ OK: Single open conversation'
    ELSE '✗ VIOLATION: ' || COUNT(*) || ' open conversations'
  END as status
FROM "Conversation"
WHERE closed_at IS NULL
GROUP BY lead_id
ORDER BY open_conversation_count DESC;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- GATE 10: Data Completeness Summary
-- ═══════════════════════════════════════════════════════════════

\echo '=== GATE 10: Overall Data Completeness ==='
\echo ''

-- Summary statistics
SELECT
  (SELECT COUNT(*) FROM "Customer") as total_customers,
  (SELECT COUNT(*) FROM "Lead") as total_leads,
  (SELECT COUNT(*) FROM "Lead" WHERE customer_id IS NOT NULL) as leads_linked,
  (SELECT COUNT(*) FROM "Job") as total_jobs,
  (SELECT COUNT(*) FROM "Job" WHERE customer_id IS NOT NULL) as jobs_linked,
  (SELECT COUNT(*) FROM "Conversation") as total_conversations,
  (SELECT COUNT(*) FROM "Conversation" WHERE closed_at IS NULL) as open_conversations,
  (SELECT COUNT(*) FROM "Message") as total_messages,
  (SELECT COUNT(*) FROM "CustomerAddress") as total_addresses;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- GATE 11: Index Usage Statistics
-- ═══════════════════════════════════════════════════════════════

\echo '=== GATE 11: Index Usage (Context Memory Indexes) ==='
\echo ''

-- Check that context memory indexes exist and are being used
SELECT
  schemaname,
  relname as tablename,
  indexrelname as indexname,
  idx_scan as scans,
  idx_tup_read as tuples_read,
  CASE
    WHEN idx_scan > 0 THEN '✓ USED'
    ELSE '○ NOT YET USED'
  END as status
FROM pg_stat_user_indexes
WHERE indexrelname IN (
  'Conversation_lead_open_unique',
  'Message_conversation_id_created_at_idx',
  'Conversation_customer_id_started_at_idx',
  'Message_content_fts_idx',
  'Message_role_idx',
  'Customer_phone_idx',
  'Customer_email_idx'
)
ORDER BY relname, indexrelname;

\echo ''

-- ═══════════════════════════════════════════════════════════════
-- FINAL GATE SUMMARY
-- ═══════════════════════════════════════════════════════════════

\echo '=== BATCH 6 VALIDATION COMPLETE ==='
\echo ''
\echo 'All gates checked. Review results above for any FAIL or WARNING status.'
\echo 'Expected: All PASS for gates 1-4, 7, 9-11. Gates 5-6, 8 are informational.'
\echo ''
