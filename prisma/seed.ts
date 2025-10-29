import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type JunkConfig = {
  tenant: string;
  service_area: unknown;
  pricebook: unknown;
  reminders: { t_minus_hours: number[] };
  quote_policy: unknown;
  channels: unknown;
};

async function loadConfig(): Promise<JunkConfig> {
  const configPath = path.join(process.cwd(), 'config', 'junk.json');
  const contents = await readFile(configPath, 'utf8');
  return JSON.parse(contents) as JunkConfig;
}

async function resetDemoData(): Promise<void> {
  await prisma.audit.deleteMany({});
  await prisma.approval.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.quote.deleteMany({});
  await prisma.lead.deleteMany({});
}

async function seed(): Promise<void> {
  const config = await loadConfig();

  await prisma.config.upsert({
    where: { tenantId: config.tenant },
    update: {
      serviceArea: config.service_area as Prisma.JsonValue,
      pricebook: config.pricebook as Prisma.JsonValue,
      reminderHours: config.reminders.t_minus_hours,
      quotePolicy: config.quote_policy as Prisma.JsonValue,
      channels: config.channels as Prisma.JsonValue,
    },
    create: {
      tenantId: config.tenant,
      serviceArea: config.service_area as Prisma.JsonValue,
      pricebook: config.pricebook as Prisma.JsonValue,
      reminderHours: config.reminders.t_minus_hours,
      quotePolicy: config.quote_policy as Prisma.JsonValue,
      channels: config.channels as Prisma.JsonValue,
    },
  });

  await resetDemoData();

  const disclaimer =
    'Estimate pending onsite confirmation. Weight/regulated items may affect final price.';

  const leadAlpha = await prisma.lead.create({
    data: {
      channel: 'messenger',
      name: 'Sam Customer',
      messengerPsid: 'demo-psid-1',
      phone: '404-555-0111',
      email: 'sam@example.com',
      address: '123 Cherry St, Woodstock, GA',
      lat: 34.1016,
      lng: -84.5194,
      curbside: true,
      stage: 'scheduling',
      stateMetadata: {
        state: 'scheduling',
        context: { awaitingSlotConfirmation: true },
      },
      lastCustomerMessageAt: new Date(),
      lastAgentMessageAt: new Date(),
    },
  });

  const alphaQuote = await prisma.quote.create({
    data: {
      leadId: leadAlpha.id,
      featuresJson: {
        volume_class: '1/2',
        cubic_yards_est: 8.0,
        bedload: false,
        bedload_type: null,
        heavy_items: ['mattress'],
        stairs_flights: 0,
        carry_distance_ft: 10,
        curbside: true,
        hazards: [],
        confidence: 0.82,
      },
      lineItemsJson: [
        { label: 'Half trailer load', amount: 429 },
        { label: 'Mattress disposal fee', amount: 20 },
      ],
      discountsJson: [{ label: 'Curbside discount', amount: -42.9 }],
      subtotal: new Prisma.Decimal('449.00'),
      total: new Prisma.Decimal('406.10'),
      confidence: new Prisma.Decimal('0.82'),
      needsApproval: false,
      status: 'sent',
      flagsJson: { low_confidence: false, curbside: true },
      notesJson: ['Customer staged items curbside.'],
      disclaimer,
    },
  });

  await prisma.job.create({
    data: {
      leadId: leadAlpha.id,
      quoteId: alphaQuote.id,
      windowStart: new Date(Date.now() + 86400000), // tomorrow
      windowEnd: new Date(Date.now() + 86400000 + 3 * 3600000),
      status: 'booked',
      reminderScheduledAt: new Date(Date.now() + 86400000 - 24 * 3600000),
    },
  });

  const leadBeta = await prisma.lead.create({
    data: {
      channel: 'messenger',
      name: 'Alex Condo',
      messengerPsid: 'demo-psid-2',
      phone: null,
      email: null,
      address: '55 Market St, Woodstock, GA',
      curbside: false,
      stage: 'awaiting_owner',
      stateMetadata: {
        state: 'awaiting_owner',
        pendingReason: 'awaiting_owner',
      },
      lastCustomerMessageAt: new Date(Date.now() - 2 * 3600000),
    },
  });

  const betaQuote = await prisma.quote.create({
    data: {
      leadId: leadBeta.id,
      featuresJson: {
        volume_class: '3/4',
        cubic_yards_est: 12.0,
        bedload: true,
        bedload_type: 'concrete_brick_tile',
        heavy_items: ['water heater', 'treadmill'],
        stairs_flights: 2,
        carry_distance_ft: 80,
        curbside: false,
        hazards: ['paint spill'],
        confidence: 0.65,
      },
      lineItemsJson: [
        { label: '3/4 trailer load', amount: 549 },
        { label: 'Stairs surcharge (2 flights)', amount: 50 },
        { label: 'Long carry surcharge (75ft)', amount: 25 },
        { label: 'Bedload concrete (2 cy)', amount: 500 },
        { label: 'Contamination cleanup', amount: 60 },
      ],
      discountsJson: [],
      subtotal: new Prisma.Decimal('1184.00'),
      total: new Prisma.Decimal('1184.00'),
      confidence: new Prisma.Decimal('0.65'),
      needsApproval: true,
      status: 'pending_approval',
      flagsJson: { low_confidence: true, hazards: ['paint spill'] },
      notesJson: ['Requires owner approval due to bedload + hazard.'],
      disclaimer,
    },
  });

  await prisma.approval.create({
    data: {
      quoteId: betaQuote.id,
      token: 'demo-approval-token',
      status: 'pending',
    },
  });

  await prisma.audit.createMany({
    data: [
      {
        leadId: leadAlpha.id,
        actor: 'system',
        action: 'seed_lead_created',
        payload: { source: 'seed' } as Prisma.JsonValue,
      },
      {
        leadId: leadBeta.id,
        actor: 'system',
        action: 'seed_lead_created',
        payload: { source: 'seed' } as Prisma.JsonValue,
      },
    ],
  });
}

seed()
  .then(async () => {
    console.log('Seed completed.');
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error('Seed failed.', error);
    await prisma.$disconnect();
    process.exit(1);
  });
