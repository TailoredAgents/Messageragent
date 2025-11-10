import { tool } from '@openai/agents';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { attachConfirmedContext } from '../lib/context.ts';
import { prisma } from '../lib/prisma.ts';

const memoryConfirmContextParameters = z.object({
  conversation_id: z.string().uuid('conversation_id must be a valid UUID'),
  candidate_ids: z
    .array(z.string().min(1, 'candidate_ids entries must be non-empty strings'))
    .nonempty('candidate_ids must include at least one entry'),
});

type MemoryConfirmContextInput = z.infer<typeof memoryConfirmContextParameters>;

type MemoryConfirmContextResult = {
  conversation_id: string;
  confirmed_ids: string[];
};

async function executeMemoryConfirmContext(
  input: MemoryConfirmContextInput,
): Promise<MemoryConfirmContextResult> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: input.conversation_id },
    select: { id: true, leadId: true },
  });

  if (!conversation) {
    throw new Error('Conversation not found.');
  }

  const confirmedIds = Array.from(new Set(input.candidate_ids));
  await attachConfirmedContext(conversation.id, confirmedIds);

  if (conversation.leadId) {
    await prisma.audit.create({
      data: {
        leadId: conversation.leadId,
        actor: 'agent',
        action: 'memory_confirm_context',
        payload: {
          conversation_id: conversation.id,
          candidate_ids: confirmedIds,
        } as Prisma.JsonObject,
      },
    });
  }

  return {
    conversation_id: conversation.id,
    confirmed_ids: confirmedIds,
  };
}

const memoryConfirmContextJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    conversation_id: {
      type: 'string',
      description: 'Conversation identifier whose metadata should be updated.',
    },
    candidate_ids: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      description: 'List of candidate IDs that were confirmed by the user.',
    },
  },
  required: ['conversation_id', 'candidate_ids'],
  $schema: 'http://json-schema.org/draft-07/schema#',
} as const;

export function buildMemoryConfirmContextTool() {
  return tool({
    name: 'memory_confirm_context',
    description:
      'Marks the selected context candidates as confirmed so the agent can safely reuse prior job details.',
    parameters: memoryConfirmContextJsonSchema,
    execute: async (args) =>
      executeMemoryConfirmContext(memoryConfirmContextParameters.parse(args)),
  });
}
