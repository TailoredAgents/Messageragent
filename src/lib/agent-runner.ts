import { Runner } from '@openai/agents';

import { attachToolTelemetry } from './tool-telemetry.ts';

export type AgentRunContext = {
  leadId: string;
  channel: 'messenger' | 'sms';
  timeZone: string;
  conversationId?: string | null;
  customerId?: string | null;
  messengerPsid?: string;
  smsFrom?: string;
  attachments?: string[];
};

let cachedRunner: Runner | null = null;

export function getRunner(): Runner {
  if (!cachedRunner) {
    cachedRunner = new Runner({
      workflowName: 'StonegateAgent Messenger',
    });
    attachToolTelemetry(cachedRunner);
  }
  return cachedRunner;
}

export function buildAgentRunContext(
  context: AgentRunContext,
): AgentRunContext & { attachments: string[] } {
  return {
    ...context,
    conversationId: context.conversationId ?? undefined,
    customerId: context.customerId ?? undefined,
    attachments: context.attachments ?? [],
  };
}
