import 'dotenv/config';

import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs/promises';

import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import fastify from 'fastify';
import ejs from 'ejs';

import { adminRoutes } from './routes/admin.ts';
import { messengerRoutes } from './routes/messenger.ts';
import { startReminderScheduler } from './lib/reminder-scheduler.ts';
import { smsRoutes } from './routes/sms.ts';
import { getRawLogger } from './lib/log.ts';

async function main(): Promise<void> {
  const server = fastify({
    logger: getRawLogger(),
  });

  server.register(fastifyView, {
    engine: { ejs },
    root: path.join(process.cwd(), 'src', 'views'),
    viewExt: 'ejs',
  });

  server.register(formbody);

  const assetsDir = path.join(process.cwd(), 'public');
  await fs.mkdir(assetsDir, { recursive: true });

  server.register(fastifyStatic, {
    root: assetsDir,
    prefix: '/assets/',
    decorateReply: false,
  });

  const calendarDir = path.join(process.cwd(), 'storage', 'calendar');
  await fs.mkdir(calendarDir, { recursive: true });

  server.register(fastifyStatic, {
    root: calendarDir,
    prefix: '/calendar/',
    decorateReply: false,
  });

  server.get('/privacy', async (_, reply) => {
    const companyName = process.env.COMPANY_NAME ?? 'Junk Wizards';
    const contactEmail = process.env.SUPPORT_EMAIL ?? 'privacy@junkwizards.com';
    const contactPhone = process.env.SUPPORT_PHONE ?? '(555) 010-0000';
    const lastUpdated = (process.env.PRIVACY_POLICY_UPDATED_AT ?? new Date().toISOString().split('T')[0]) as string;

    return reply.view('privacy.ejs', {
      companyName,
      contactEmail,
      contactPhone,
      lastUpdated,
    });
  });

  server.get('/healthz', async () => ({ status: 'ok' }));

  await server.register(messengerRoutes);
  await server.register(smsRoutes);
  await server.register(adminRoutes);

  // Start reminder scheduler based on env toggles.
  // Prefer ENABLE_SCHEDULER='true' if explicitly set (worker-first model upstream).
  // Otherwise, fall back to ENABLE_REMINDERS toggle (defaults to enabled).
  if (typeof process.env.ENABLE_SCHEDULER !== 'undefined') {
    if (process.env.ENABLE_SCHEDULER === 'true') {
      server.log.warn('Starting reminder scheduler in web process (as ENABLE_SCHEDULER=true)');
      startReminderScheduler();
    } else {
      server.log.info('Reminders disabled via ENABLE_SCHEDULER');
    }
  } else {
    const enableReminders = String(process.env.ENABLE_REMINDERS ?? 'true')
      .toLowerCase()
      .trim();
    if (!['0', 'false', 'no', 'off'].includes(enableReminders)) {
      startReminderScheduler();
    } else {
      server.log.info('Reminders disabled via ENABLE_REMINDERS');
    }
  }

  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  const host = process.env.HOST ?? '0.0.0.0';

  try {
    await server.listen({ host, port });
    server.log.info(`Server listening on http://${host}:${port}`);
  } catch (error) {
    server.log.error(error);
    process.exit(1);
  }
}

void main();
