import { Runner } from '@openai/agents';

import { attachToolTelemetry } from './tool-telemetry.ts';

let cachedRunner: Runner | null = null;

export function getRunner(): Runner {
  if (!cachedRunner) {
    cachedRunner = new Runner({
      workflowName: 'JunkQuoteAgent Messenger',
    });
    attachToolTelemetry(cachedRunner);
  }
  return cachedRunner;
}
