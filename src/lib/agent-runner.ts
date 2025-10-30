import { Runner } from '@openai/agents';

let cachedRunner: Runner | null = null;

export function getRunner(): Runner {
  if (!cachedRunner) {
    cachedRunner = new Runner({
      workflowName: 'JunkQuoteAgent Messenger',
    });
  }
  return cachedRunner;
}

