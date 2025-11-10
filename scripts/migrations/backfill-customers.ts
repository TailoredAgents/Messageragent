#!/usr/bin/env tsx
/**
 * Batch 3: Backfill Customer records and link to Leads/Jobs
 *
 * This script is IDEMPOTENT - safe to run multiple times.
 *
 * Logic:
 * 1. Group leads by identifier (messengerPsid, normalized phone, email)
 * 2. Create Customer for each group
 * 3. Link Lead.customerId to Customer
 * 4. Link Job.customerId to Customer via Lead
 * 5. Record backfill run in Audit table
 *
 * Usage:
 *   npx tsx scripts/migrations/backfill-customers.ts [--dry-run] [--verbose]
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface MigrationStats {
  customersCreated: number;
  customersSkipped: number;
  leadsLinked: number;
  leadsAlreadyLinked: number;
  jobsLinked: number;
  jobsAlreadyLinked: number;
  errors: string[];
}

interface CustomerGrouping {
  groupKey: string;
  groupType: 'psid' | 'phone' | 'email' | 'individual';
  leadIds: string[];
  name?: string;
  phone?: string;
  email?: string;
  metadata: Record<string, unknown>;
}

/**
 * Normalize phone number for grouping (remove non-digits)
 */
function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  // Require at least 10 digits for valid phone
  return digits.length >= 10 ? digits : null;
}

/**
 * Normalize email for grouping (lowercase, trim)
 */
function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  // Basic email validation
  return normalized.includes('@') ? normalized : null;
}

/**
 * Group leads by customer identifiers
 */
async function groupLeadsByCustomer(
  verbose: boolean
): Promise<Map<string, CustomerGrouping>> {
  const leads = await prisma.lead.findMany({
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      messengerPsid: true,
      customerId: true,
    },
  });

  if (verbose) {
    console.log(`📊 Found ${leads.length} total leads`);
  }

  const groups = new Map<string, CustomerGrouping>();

  for (const lead of leads) {
    // Skip if already linked (idempotent)
    if (lead.customerId) {
      continue;
    }

    let groupKey: string;
    let groupType: CustomerGrouping['groupType'];

    // Priority 1: Group by Messenger PSID (most reliable for messenger)
    if (lead.messengerPsid) {
      groupKey = `psid:${lead.messengerPsid}`;
      groupType = 'psid';
    }
    // Priority 2: Group by normalized phone (reliable for SMS and phone-based leads)
    else if (normalizePhone(lead.phone)) {
      groupKey = `phone:${normalizePhone(lead.phone)}`;
      groupType = 'phone';
    }
    // Priority 3: Group by email (less reliable, conservative merge)
    else if (normalizeEmail(lead.email)) {
      groupKey = `email:${normalizeEmail(lead.email)}`;
      groupType = 'email';
    }
    // Fallback: Individual customer per lead
    else {
      groupKey = `individual:${lead.id}`;
      groupType = 'individual';
    }

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        groupKey,
        groupType,
        leadIds: [],
        name: lead.name || undefined,
        phone: lead.phone || undefined,
        email: lead.email || undefined,
        metadata: {},
      });
    }

    const group = groups.get(groupKey)!;
    group.leadIds.push(lead.id);

    // Merge metadata from multiple leads in same group
    if (lead.name && !group.name) {
      group.name = lead.name;
    }
    if (lead.phone && !group.phone) {
      group.phone = lead.phone;
    }
    if (lead.email && !group.email) {
      group.email = lead.email;
    }

    // Track multiple leads per group in metadata
    if (group.leadIds.length > 1) {
      group.metadata.multipleLeads = true;
      group.metadata.leadCount = group.leadIds.length;
    }
  }

  if (verbose) {
    console.log(`🔗 Grouped into ${groups.size} potential customers`);
    console.log(
      `   - By PSID: ${
        Array.from(groups.values()).filter((g) => g.groupType === 'psid').length
      }`
    );
    console.log(
      `   - By Phone: ${
        Array.from(groups.values()).filter((g) => g.groupType === 'phone')
          .length
      }`
    );
    console.log(
      `   - By Email: ${
        Array.from(groups.values()).filter((g) => g.groupType === 'email')
          .length
      }`
    );
    console.log(
      `   - Individual: ${
        Array.from(groups.values()).filter((g) => g.groupType === 'individual')
          .length
      }`
    );
  }

  return groups;
}

/**
 * Check if customer already exists for this grouping
 */
async function findExistingCustomer(
  group: CustomerGrouping
): Promise<string | null> {
  // Check if any lead in this group already has a customer
  const leadsWithCustomer = await prisma.lead.findMany({
    where: {
      id: { in: group.leadIds },
      customerId: { not: null },
    },
    select: { customerId: true },
  });

  if (leadsWithCustomer.length > 0) {
    // Return the existing customer ID (assume all leads in group have same customer)
    return leadsWithCustomer[0].customerId!;
  }

  // Check if customer exists by phone/email
  if (group.groupType === 'phone' && group.phone) {
    const existing = await prisma.customer.findFirst({
      where: { phone: normalizePhone(group.phone) },
      select: { id: true },
    });
    if (existing) return existing.id;
  }

  if (group.groupType === 'email' && group.email) {
    const existing = await prisma.customer.findFirst({
      where: { email: normalizeEmail(group.email) },
      select: { id: true },
    });
    if (existing) return existing.id;
  }

  return null;
}

/**
 * Create customer for a grouping
 */
async function createCustomerForGroup(
  group: CustomerGrouping,
  verbose: boolean
): Promise<string> {
  const customer = await prisma.customer.create({
    data: {
      name: group.name,
      phone: normalizePhone(group.phone),
      email: normalizeEmail(group.email),
      metadata: {
        groupType: group.groupType,
        groupKey: group.groupKey,
        leadCount: group.leadIds.length,
        createdBy: 'backfill-customers.ts',
        createdAt: new Date().toISOString(),
        ...group.metadata,
      },
    },
  });

  if (verbose) {
    console.log(
      `   ✓ Created customer ${customer.id} (${group.groupType}, ${group.leadIds.length} lead${group.leadIds.length > 1 ? 's' : ''})`
    );
  }

  return customer.id;
}

/**
 * Link leads to customer
 */
async function linkLeadsToCustomer(
  customerId: string,
  leadIds: string[],
  verbose: boolean
): Promise<number> {
  const result = await prisma.lead.updateMany({
    where: {
      id: { in: leadIds },
      customerId: null, // Only update if not already linked
    },
    data: { customerId },
  });

  if (verbose && result.count > 0) {
    console.log(`   ✓ Linked ${result.count} lead(s) to customer ${customerId}`);
  }

  return result.count;
}

/**
 * Link jobs to customer via their leads
 */
async function linkJobsToCustomers(verbose: boolean): Promise<number> {
  // Find all jobs where customerId is null but lead has customerId
  const jobsNeedingLink = await prisma.job.findMany({
    where: {
      customerId: null,
      lead: {
        customerId: { not: null },
      },
    },
    select: {
      id: true,
      leadId: true,
      lead: {
        select: { customerId: true },
      },
    },
  });

  if (jobsNeedingLink.length === 0) {
    if (verbose) {
      console.log('   ℹ No jobs need customer linking');
    }
    return 0;
  }

  // Update each job with its lead's customer
  let linkedCount = 0;
  for (const job of jobsNeedingLink) {
    if (job.lead.customerId) {
      await prisma.job.update({
        where: { id: job.id },
        data: { customerId: job.lead.customerId },
      });
      linkedCount++;
    }
  }

  if (verbose) {
    console.log(`   ✓ Linked ${linkedCount} job(s) to customers`);
  }

  return linkedCount;
}

/**
 * Record backfill run in Audit table
 */
async function recordBackfillAudit(
  stats: MigrationStats,
  dryRun: boolean
): Promise<void> {
  await prisma.audit.create({
    data: {
      actor: 'system',
      action: dryRun ? 'backfill_customers_dry_run' : 'backfill_customers',
      payload: {
        timestamp: new Date().toISOString(),
        stats,
        script: 'backfill-customers.ts',
        version: 'batch-3',
      },
    },
  });
}

/**
 * Main backfill execution
 */
async function runBackfill(
  dryRun: boolean,
  verbose: boolean
): Promise<MigrationStats> {
  const stats: MigrationStats = {
    customersCreated: 0,
    customersSkipped: 0,
    leadsLinked: 0,
    leadsAlreadyLinked: 0,
    jobsLinked: 0,
    jobsAlreadyLinked: 0,
    errors: [],
  };

  console.log('🚀 Starting Batch 3: Customer Backfill');
  console.log(`   Mode: ${dryRun ? '🔍 DRY RUN' : '✏️  WRITE'}`);
  console.log('');

  // Step 1: Group leads by customer identifiers
  console.log('[1/4] Grouping leads by customer identifiers...');
  const groups = await groupLeadsByCustomer(verbose);
  console.log('');

  // Step 2: Create customers and link leads
  console.log('[2/4] Creating customers and linking leads...');
  for (const group of groups.values()) {
    try {
      // Check if customer already exists
      const existingCustomerId = await findExistingCustomer(group);

      let customerId: string;
      if (existingCustomerId) {
        customerId = existingCustomerId;
        stats.customersSkipped++;
        if (verbose) {
          console.log(
            `   ⊙ Using existing customer ${customerId} for ${group.leadIds.length} lead(s)`
          );
        }
      } else {
        if (!dryRun) {
          customerId = await createCustomerForGroup(group, verbose);
          stats.customersCreated++;
        } else {
          if (verbose) {
            console.log(
              `   [DRY RUN] Would create customer (${group.groupType}, ${group.leadIds.length} lead${group.leadIds.length > 1 ? 's' : ''})`
            );
          }
          stats.customersCreated++;
          continue;
        }
      }

      // Link leads to customer
      if (!dryRun) {
        const linked = await linkLeadsToCustomer(
          customerId,
          group.leadIds,
          verbose
        );
        stats.leadsLinked += linked;
        stats.leadsAlreadyLinked += group.leadIds.length - linked;
      } else {
        stats.leadsLinked += group.leadIds.length;
      }
    } catch (error) {
      const err = error as Error;
      console.error(`   ✗ Error processing group ${group.groupKey}:`, err.message);
      stats.errors.push(`${group.groupKey}: ${err.message}`);
    }
  }
  console.log('');

  // Step 3: Link jobs to customers
  console.log('[3/4] Linking jobs to customers...');
  if (!dryRun) {
    stats.jobsLinked = await linkJobsToCustomers(verbose);
  } else {
    // Count jobs that would be linked
    const jobsNeedingLink = await prisma.job.count({
      where: {
        customerId: null,
        lead: { customerId: { not: null } },
      },
    });
    stats.jobsLinked = jobsNeedingLink;
    if (verbose) {
      console.log(`   [DRY RUN] Would link ${jobsNeedingLink} job(s)`);
    }
  }
  console.log('');

  // Step 4: Record audit log
  console.log('[4/4] Recording audit log...');
  if (!dryRun) {
    await recordBackfillAudit(stats, false);
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
  console.log(
    `${dryRun ? '🔍 DRY RUN' : '✅ BACKFILL'} COMPLETE`
  );
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('📊 Statistics:');
  console.log(`   Customers created:      ${stats.customersCreated}`);
  console.log(`   Customers reused:       ${stats.customersSkipped}`);
  console.log(`   Leads linked:           ${stats.leadsLinked}`);
  console.log(`   Leads already linked:   ${stats.leadsAlreadyLinked}`);
  console.log(`   Jobs linked:            ${stats.jobsLinked}`);
  console.log(`   Jobs already linked:    ${stats.jobsAlreadyLinked}`);
  console.log(`   Errors:                 ${stats.errors.length}`);
  console.log('');

  if (stats.errors.length > 0) {
    console.log('⚠️  Errors encountered:');
    stats.errors.forEach((err) => console.log(`   - ${err}`));
    console.log('');
  }

  if (dryRun) {
    console.log('ℹ️  This was a dry run. Run without --dry-run to apply changes.');
  } else {
    console.log('✅ Backfill completed successfully!');
    console.log('');
    console.log('Next steps:');
    console.log('   1. Run validation queries (see validation.sql)');
    console.log('   2. Verify customer linkage');
    console.log('   3. Check for any NULL customer_id values');
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

export { runBackfill, groupLeadsByCustomer };
