import 'dotenv/config';

import process from 'node:process';

import { startReminderScheduler } from './lib/reminder-scheduler.js';
import { startCalendarSync } from './lib/calendar-sync.js';

async function main(): Promise<void> {
  console.log('Starting reminder worker...');

  // Start the reminder scheduler
  startReminderScheduler();
  void startCalendarSync();

  console.log('Reminder worker started successfully');
  console.log('Polling for reminders every 60 seconds...');
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

void main();
