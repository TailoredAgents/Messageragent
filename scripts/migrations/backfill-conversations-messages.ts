#!/usr/bin/env tsx
/**
 * Batch 4: Backfill Conversations and Messages from Audit logs
 *
 * This script is IDEMPOTENT - safe to run multiple times.
 *
 * Logic:
 * 1. Create one Conversation per Lead
 * 2. Extract messages from Audit logs (actor: customer/agent)
 * 3. Create Message records with proper roles
 * 4. Use audit.id as upsert key for idempotency
 *
 * Usage:
 *   npx tsx scripts/migrations/backfill-conversations-messages.ts [--dry-run] [--verbose]
 */

import { PrismaClient, MessageRole } from '@prisma/client';

const prisma = new PrismaClient();

interface MigrationStats {
  conversationsCreated: number;
  conversationsSkipped: number;
  messagesCreated: number;
  messagesSkipped: number;
  auditsProcessed: number;
  auditsSkipped: number;
  errors: string[];
}

interface AuditRecord {
  id: string;
  leadId: string | null;
  actor: string;
  action: string;
  payload: any;
  createdAt: Date;
}

/**
 * Extract message text from audit payload
 */
function extractMessageText(payload: any, action: string): string | null {
  // Priority 1: Direct text field
  if (payload?.text && typeof payload.text === 'string') {
    return payload.text.trim();
  }

  // Priority 2: Message field
  if (payload?.message && typeof payload.message === 'string') {
    return payload.message.trim();
  }

  // Priority 3: Content field
  if (payload?.content && typeof payload.content === 'string') {
    return payload.content.trim();
  }

  // Priority 4: For specific actions, extract relevant data
  if (action === 'message_sent' || action === 'message_received') {
    if (payload?.body && typeof payload.body === 'string') {
      return payload.body.trim();
    }
  }

  // Fallback: Compact JSON representation (max 1000 chars)
  try {
    const compactJson = JSON.stringify(payload, null, 0);
    return compactJson.length <= 1000
      ? compactJson
      : compactJson.substring(0, 997) + '...';
  } catch {
    return null;
  }
}

/**
 * Determine message role from audit actor
 */
function getMessageRole(actor: string): MessageRole {
  const lowerActor = actor.toLowerCase();

  if (lowerActor === 'customer' || lowerActor === 'user') {
    return 'user';
  }

  if (lowerActor === 'agent' || lowerActor === 'assistant' || lowerActor === 'system') {
    return 'assistant';
  }

  if (lowerActor === 'tool') {
    return 'tool';
  }

  // Default: system for unknown actors
  return 'system';
}

/**
 * Create conversation for a lead
 */
async function createConversationForLead(
  leadId: string,
  verbose: boolean
): Promise<string | null> {
  try {
    // Check if conversation already exists
    const existing = await prisma.conversation.findFirst({
      where: {
        leadId,
        metadata: {
          path: ['source'],
          equals: 'audit_backfill',
        },
      },
      select: { id: true },
    });

    if (existing) {
      if (verbose) {
        console.log(`   ⊙ Conversation already exists for lead ${leadId}`);
      }
      return existing.id;
    }

    // Get lead details
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: {
        channel: true,
        customerId: true,
        messengerPsid: true,
        phone: true,
        stage: true,
        createdAt: true,
      },
    });

    if (!lead) {
      console.warn(`   ⚠ Lead ${leadId} not found, skipping`);
      return null;
    }

    // Create conversation
    const conversation = await prisma.conversation.create({
      data: {
        leadId,
        customerId: lead.customerId,
        channel: lead.channel,
        externalId: lead.messengerPsid || lead.phone || null,
        startedAt: lead.createdAt,
        lastMessageAt: null, // Will be updated as messages are added
        metadata: {
          source: 'audit_backfill',
          leadStage: lead.stage,
          createdBy: 'backfill-conversations-messages.ts',
          createdAt: new Date().toISOString(),
        },
      },
    });

    if (verbose) {
      console.log(
        `   ✓ Created conversation ${conversation.id} for lead ${leadId}`
      );
    }

    return conversation.id;
  } catch (error) {
    const err = error as Error;
    console.error(`   ✗ Error creating conversation for lead ${leadId}:`, err.message);
    return null;
  }
}

/**
 * Create message from audit record
 */
async function createMessageFromAudit(
  audit: AuditRecord,
  conversationId: string,
  verbose: boolean
): Promise<boolean> {
  try {
    // Check if message already exists (idempotency via audit.id)
    const existing = await prisma.message.findFirst({
      where: {
        metadata: {
          path: ['auditId'],
          equals: audit.id,
        },
      },
      select: { id: true },
    });

    if (existing) {
      return false; // Already exists, skip
    }

    // Extract message text
    const content = extractMessageText(audit.payload, audit.action);
    if (!content) {
      if (verbose) {
        console.log(`   ⊙ Skipping audit ${audit.id} (no extractable text)`);
      }
      return false;
    }

    // Determine role
    const role = getMessageRole(audit.actor);

    // Create message
    await prisma.message.create({
      data: {
        conversationId,
        role,
        content,
        createdAt: audit.createdAt,
        metadata: {
          auditId: audit.id,
          auditAction: audit.action,
          auditActor: audit.actor,
          source: 'audit_backfill',
          createdBy: 'backfill-conversations-messages.ts',
        },
      },
    });

    // Update conversation lastMessageAt
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: audit.createdAt,
      },
    });

    if (verbose) {
      console.log(
        `   ✓ Created message from audit ${audit.id} (role: ${role}, ${content.length} chars)`
      );
    }

    return true;
  } catch (error) {
    const err = error as Error;
    console.error(`   ✗ Error creating message from audit ${audit.id}:`, err.message);
    return false;
  }
}

/**
 * Fetch audits for message extraction
 */
async function fetchAuditsForMessages(
  verbose: boolean
): Promise<AuditRecord[]> {
  const audits = await prisma.audit.findMany({
    where: {
      leadId: { not: null },
      actor: {
        in: ['customer', 'agent', 'user', 'assistant', 'system'],
      },
    },
    select: {
      id: true,
      leadId: true,
      actor: true,
      action: true,
      payload: true,
      createdAt: true,
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  if (verbose) {
    console.log(`📊 Found ${audits.length} audit records with messages`);
  }

  return audits as AuditRecord[];
}

/**
 * Group audits by lead
 */
function groupAuditsByLead(audits: AuditRecord[]): Map<string, AuditRecord[]> {
  const groups = new Map<string, AuditRecord[]>();

  for (const audit of audits) {
    if (!audit.leadId) continue;

    if (!groups.has(audit.leadId)) {
      groups.set(audit.leadId, []);
    }

    groups.get(audit.leadId)!.push(audit);
  }

  return groups;
}

/**
 * Main backfill execution
 */
async function runBackfill(
  dryRun: boolean,
  verbose: boolean
): Promise<MigrationStats> {
  const stats: MigrationStats = {
    conversationsCreated: 0,
    conversationsSkipped: 0,
    messagesCreated: 0,
    messagesSkipped: 0,
    auditsProcessed: 0,
    auditsSkipped: 0,
    errors: [],
  };

  console.log('🚀 Starting Batch 4: Conversation & Message Backfill');
  console.log(`   Mode: ${dryRun ? '🔍 DRY RUN' : '✏️  WRITE'}`);
  console.log('');

  // Step 1: Fetch audits
  console.log('[1/4] Fetching audit records...');
  const audits = await fetchAuditsForMessages(verbose);
  const auditsByLead = groupAuditsByLead(audits);
  console.log(`🔗 Grouped into ${auditsByLead.size} leads with audit history`);
  console.log('');

  // Step 2: Create conversations
  console.log('[2/4] Creating conversations for leads...');
  const conversationMap = new Map<string, string>(); // leadId → conversationId

  for (const leadId of auditsByLead.keys()) {
    if (dryRun) {
      if (verbose) {
        console.log(`   [DRY RUN] Would create conversation for lead ${leadId}`);
      }
      stats.conversationsCreated++;
      conversationMap.set(leadId, `dry-run-conversation-${leadId}`);
    } else {
      const conversationId = await createConversationForLead(leadId, verbose);
      if (conversationId) {
        conversationMap.set(leadId, conversationId);
        stats.conversationsCreated++;
      } else {
        stats.conversationsSkipped++;
      }
    }
  }
  console.log('');

  // Step 3: Create messages from audits
  console.log('[3/4] Creating messages from audit logs...');
  for (const [leadId, leadAudits] of auditsByLead.entries()) {
    const conversationId = conversationMap.get(leadId);
    if (!conversationId) {
      if (verbose) {
        console.log(`   ⚠ No conversation for lead ${leadId}, skipping messages`);
      }
      stats.auditsSkipped += leadAudits.length;
      continue;
    }

    for (const audit of leadAudits) {
      try {
        if (dryRun) {
          const content = extractMessageText(audit.payload, audit.action);
          if (content) {
            if (verbose) {
              console.log(
                `   [DRY RUN] Would create message from audit ${audit.id} (${content.substring(0, 50)}...)`
              );
            }
            stats.messagesCreated++;
          } else {
            stats.messagesSkipped++;
          }
          stats.auditsProcessed++;
        } else {
          const created = await createMessageFromAudit(
            audit,
            conversationId,
            verbose
          );
          if (created) {
            stats.messagesCreated++;
          } else {
            stats.messagesSkipped++;
          }
          stats.auditsProcessed++;
        }
      } catch (error) {
        const err = error as Error;
        console.error(`   ✗ Error processing audit ${audit.id}:`, err.message);
        stats.errors.push(`${audit.id}: ${err.message}`);
      }
    }
  }
  console.log('');

  // Step 4: Record audit log
  console.log('[4/4] Recording audit log...');
  if (!dryRun) {
    await prisma.audit.create({
      data: {
        actor: 'system',
        action: 'backfill_conversations_messages',
        payload: {
          timestamp: new Date().toISOString(),
          stats,
          script: 'backfill-conversations-messages.ts',
          version: 'batch-4',
        },
      },
    });
    console.log('   ✓ Audit log created');
  } else {
    console.log('   [DRY RUN] Would create audit log');
  }
  console.log('');

  return stats;
}

/**
 * Print summary statistics
 */
function printSummary(stats: MigrationStats, dryRun: boolean): void {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`${dryRun ? '🔍 DRY RUN' : '✅ BACKFILL'} COMPLETE`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('📊 Statistics:');
  console.log(`   Conversations created:  ${stats.conversationsCreated}`);
  console.log(`   Conversations skipped:  ${stats.conversationsSkipped}`);
  console.log(`   Messages created:       ${stats.messagesCreated}`);
  console.log(`   Messages skipped:       ${stats.messagesSkipped}`);
  console.log(`   Audits processed:       ${stats.auditsProcessed}`);
  console.log(`   Audits skipped:         ${stats.auditsSkipped}`);
  console.log(`   Errors:                 ${stats.errors.length}`);
  console.log('');

  if (stats.errors.length > 0) {
    console.log('⚠️  Errors encountered:');
    stats.errors.slice(0, 10).forEach((err) => console.log(`   - ${err}`));
    if (stats.errors.length > 10) {
      console.log(`   ... and ${stats.errors.length - 10} more`);
    }
    console.log('');
  }

  if (dryRun) {
    console.log('ℹ️  This was a dry run. Run without --dry-run to apply changes.');
  } else {
    console.log('✅ Backfill completed successfully!');
    console.log('');
    console.log('Next steps:');
    console.log('   1. Run validation queries');
    console.log('   2. Test FTS search on messages');
    console.log('   3. Verify conversation → message linking');
    console.log('   4. Enable CONTEXT_MEMORY_ENABLED=true');
  }
  console.log('');
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose') || args.includes('-v');

  try {
    const stats = await runBackfill(dryRun, verbose);
    printSummary(stats, dryRun);
    process.exit(stats.errors.length > 0 ? 1 : 0);
  } catch (error) {
    console.error('💥 Fatal error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run if executed directly (ES module compatible)
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}

export { runBackfill, extractMessageText, getMessageRole };
