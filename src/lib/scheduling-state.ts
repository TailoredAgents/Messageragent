import { Prisma } from '@prisma/client';

import { prisma } from './prisma.ts';

export type SchedulingState = {
  pending_confirmation?: {
    iso: string;
    label: string;
    prompt: string;
    preferred_text?: string | null;
    timeZone: string;
  } | null;
  last_slots_prompt_at?: string | null;
  last_slots_prompt_text?: string | null;
};

type JsonObject = Record<string, unknown>;

function coerceJsonObject(value: Prisma.JsonValue | null | undefined): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as JsonObject;
}

export function readSchedulingState(
  metadata: Prisma.JsonValue | null,
): SchedulingState {
  const object = coerceJsonObject(metadata);
  const scheduling = object.scheduling_state;
  if (!scheduling || typeof scheduling !== 'object' || Array.isArray(scheduling)) {
    return {};
  }
  return scheduling as SchedulingState;
}

export async function writeSchedulingState({
  conversationId,
  existingMetadata,
  nextState,
}: {
  conversationId: string;
  existingMetadata: Prisma.JsonValue | null;
  nextState: SchedulingState;
}): Promise<Prisma.JsonObject> {
  const object = coerceJsonObject(existingMetadata);
  const updatedMetadata: JsonObject = {
    ...object,
    scheduling_state: nextState,
  };
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { metadata: updatedMetadata as Prisma.JsonObject },
  });
  return updatedMetadata as Prisma.JsonObject;
}
