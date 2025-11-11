import { Prisma } from '@prisma/client';

import { prisma } from './prisma.ts';

export type ContextMemoryState = Record<string, unknown>;

type JsonObject = Record<string, unknown>;

function coerceJsonObject(value: Prisma.JsonValue | null | undefined): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as JsonObject;
}

export function readContextMemoryState(
  metadata: Prisma.JsonValue | null,
): ContextMemoryState {
  const object = coerceJsonObject(metadata);
  const contextMemory = object.context_memory;
  if (!contextMemory || typeof contextMemory !== 'object' || Array.isArray(contextMemory)) {
    return {};
  }
  return { ...(contextMemory as JsonObject) };
}

export async function writeContextMemoryState({
  conversationId,
  existingMetadata,
  nextState,
}: {
  conversationId: string;
  existingMetadata: Prisma.JsonValue | null;
  nextState: ContextMemoryState;
}): Promise<Prisma.JsonObject> {
  const object = coerceJsonObject(existingMetadata);
  const updatedMetadata: JsonObject = {
    ...object,
    context_memory: nextState,
  };
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { metadata: updatedMetadata as Prisma.JsonObject },
  });
  return updatedMetadata as Prisma.JsonObject;
}
