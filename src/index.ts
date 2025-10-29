import 'dotenv/config';

import path from 'node:path';
import process from 'node:process';

import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import pointOfView from 'point-of-view';
import ejs from 'ejs';

import { adminRoutes } from './routes/admin.js';
import { messengerRoutes } from './routes/messenger.js';
import { startReminderScheduler } from './lib/reminder-scheduler.js';
import { smsRoutes } from './routes/sms.js';

async function main(): Promise<void> {
  const server = Fastify({
    logger: true,
  });

  server.register(pointOfView, {
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
