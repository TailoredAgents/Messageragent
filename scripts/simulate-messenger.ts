#!/usr/bin/env tsx
import process from 'node:process';

import { getJunkQuoteAgent } from '../src/agent/index.ts';
import { getRunner } from '../src/lib/agent-runner.ts';
import { prisma } from '../src/lib/prisma.ts';
import { buildAgentInput } from '../src/routes/messenger.ts';
import { recordLeadAttachments } from '../src/lib/attachments.ts';
import { maybeRunVisionAutomation } from '../src/lib/vision-automation.ts';

async function resolveLead(leadId?: string) {
  if (leadId) {
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      include: { quotes: { orderBy: { createdAt: 'desc' } } },
    });
    if (!lead) {
      throw new Error(`Lead ${leadId} not found.`);
    }
    return lead;
  }

  const lead = await prisma.lead.findFirst({
    orderBy: { createdAt: 'desc' },
    include: { quotes: { orderBy: { createdAt: 'desc' } } },
  });

  if (!lead) {
    throw new Error('No leads available in the database.');
  }

  return lead;
}

async function main() {
  const args = process.argv.slice(2);
  const [leadIdArg, ...rest] = args;
  const messageParts: string[] = [];
  const imageUrls: string[] = [];

  for (const part of rest) {
    if (/^https:\/\//i.test(part)) {
      imageUrls.push(part);
    } else {
      messageParts.push(part);
    }
  }
  const lead = await resolveLead(leadIdArg);
  const text =
    messageParts.length > 0
      ? messageParts.join(' ')
      : 'Hi Austin, can I get a quote for these items?';

  let attachments: string[] = imageUrls;

  const runner = getRunner();
  const agent = getJunkQuoteAgent();

  const input = buildAgentInput({
    lead,
    text,
    attachments,
  });

  const context = {
    leadId: lead.id,
    messengerPsid: lead.messengerPsid ?? 'simulation',
    attachments,
  };

  console.info('--- Messenger Simulation ---');
  console.info('Lead:', lead.id, '-', lead.name);
  console.info('Message:', text);
  console.info('Attachments:', attachments.length);

  if (attachments.length > 0) {
    // Persist unique attachments and trigger auto-analysis like the webhook does.
    attachments = await recordLeadAttachments(lead.id, attachments, 'messenger');
    await maybeRunVisionAutomation({ lead, attachments, channel: 'messenger' });
  }

  const start = Date.now();
  const result = await runner.run(agent, input, { context });
  const duration = Date.now() - start;

  console.info(`Agent run completed in ${duration}ms`);
  console.dir(result, { depth: null });
}

main()
  .catch((error) => {
    console.error('Simulation failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
