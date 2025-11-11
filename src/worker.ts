import 'dotenv/config';

import process from 'node:process';

import { startReminderScheduler } from './lib/reminder-scheduler.js';
import { startCalendarSync } from './lib/calendar-sync.js';
import { getLogger } from './lib/log.ts';

const log = getLogger().child({ module: 'worker' });

async function main(): Promise<void> {
  log.info('Starting reminder worker...');

  // Start the reminder scheduler
  startReminderScheduler();
  void startCalendarSync();

  log.info({ poll_interval_ms: 60_000 }, 'Reminder worker started successfully.');
  log.info('Polling for reminders every 60 seconds...');
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  log.warn('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  log.warn('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

void main();
