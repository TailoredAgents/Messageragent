import 'dotenv/config';

import path from 'node:path';
import process from 'node:process';

import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import fastify from 'fastify';
import ejs from 'ejs';

import { adminRoutes } from './routes/admin.ts';
import { messengerRoutes } from './routes/messenger.ts';
import { startReminderScheduler } from './lib/reminder-scheduler.ts';
import { smsRoutes } from './routes/sms.ts';

async function main(): Promise<void> {
  const server = fastify({
    logger: true,
  });

  server.register(fastifyView, {
    engine: { ejs },
    root: path.join(process.cwd(), 'src', 'views'),
    viewExt: 'ejs',
  });

  server.register(formbody);

  server.register(fastifyStatic, {
    root: path.join(process.cwd(), 'storage', 'calendar'),
    prefix: '/calendar/',
    decorateReply: false,
  });

  server.get('/healthz', async () => ({ status: 'ok' }));

  await server.register(messengerRoutes);
  await server.register(smsRoutes);
  await server.register(adminRoutes);

  startReminderScheduler();

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
