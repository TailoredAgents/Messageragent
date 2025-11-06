import { afterAll, describe, expect, it, vi } from 'vitest';

const mockOpenAIClient = () => ({
  responses: {
    create: vi.fn(),
  },
});

vi.mock('../src/lib/openai.ts', () => ({
  getOpenAIClient: mockOpenAIClient,
}));

vi.mock('../src/lib/openai.js', () => ({
  getOpenAIClient: mockOpenAIClient,
}));

type ToolBuilder = () => { type: string; parameters: unknown };

const TOOL_BUILDERS: Array<{ name: string; loader: () => Promise<ToolBuilder> }> = [
  {
    name: 'analyze_images',
    loader: async () => (await import('../src/tools/analyze-images.ts')).buildAnalyzeImagesTool,
  },
  {
    name: 'price_from_rules',
    loader: async () => (await import('../src/tools/price-from-rules.ts')).buildPriceFromRulesTool,
  },
  {
    name: 'propose_slots',
    loader: async () => (await import('../src/tools/propose-slots.ts')).buildProposeSlotsTool,
  },
  {
    name: 'confirm_slot',
    loader: async () => (await import('../src/tools/confirm-slot.ts')).buildConfirmSlotTool,
  },
  {
    name: 'send_message',
    loader: async () => (await import('../src/tools/send-message.ts')).buildSendMessageTool,
  },
];

type JsonLike = Record<string, unknown>;

function assertNoZodArtifacts(value: unknown) {
  if (!value || typeof value !== 'object') {
    return;
  }
  expect((value as JsonLike)._def).toBeUndefined();
  expect((value as JsonLike).typeName).toBeUndefined();
  Object.values(value as JsonLike).forEach(assertNoZodArtifacts);
}

function assertObjectSchema(schema: JsonLike, path: string[] = []) {
  expect(schema.type).toBe('object');
  expect(schema.additionalProperties ?? false).toBe(false);

  const properties = (schema.properties ?? {}) as JsonLike;
  const required = Array.isArray(schema.required) ? schema.required : [];

  const propertyKeys = Object.keys(properties);
  expect(required.sort()).toEqual(propertyKeys.sort());

  for (const [key, propertySchema] of Object.entries(properties)) {
    const nextPath = [...path, key];
    if (!propertySchema || typeof propertySchema !== 'object') {
      continue;
    }

    if ((propertySchema as JsonLike).type === 'object') {
      assertObjectSchema(propertySchema as JsonLike, nextPath);
      continue;
    }

    if ((propertySchema as JsonLike).type === 'array') {
      const items = (propertySchema as JsonLike).items;
      if (items && typeof items === 'object' && (items as JsonLike).type === 'object') {
        assertObjectSchema(items as JsonLike, [...nextPath, 'items']);
      }
    }

    const anyOf = (propertySchema as JsonLike).anyOf;
    if (Array.isArray(anyOf)) {
      anyOf.forEach((entry, index) => {
        if (entry && typeof entry === 'object' && (entry as JsonLike).type === 'object') {
          assertObjectSchema(entry as JsonLike, [...nextPath, `anyOf[${index}]`]);
        }
        if (
          entry &&
          typeof entry === 'object' &&
          (entry as JsonLike).type === 'array' &&
          (entry as JsonLike).items &&
          typeof (entry as JsonLike).items === 'object' &&
          ((entry as JsonLike).items as JsonLike).type === 'object'
        ) {
          assertObjectSchema(((entry as JsonLike).items as JsonLike) as JsonLike, [
            ...nextPath,
            `anyOf[${index}]`,
            'items',
          ]);
        }
      });
    }
  }
}

describe('tool parameter schemas', () => {
  TOOL_BUILDERS.forEach(({ name, loader }) => {
    it(`${name} exposes a fully-specified JSON schema`, async () => {
      const build = await loader();
      const toolDefinition = build();
      expect(toolDefinition.type).toBe('function');

      const schema = toolDefinition.parameters as JsonLike;
      expect(schema).toBeDefined();
      assertNoZodArtifacts(schema);
      assertObjectSchema(schema);
    });
  });
});

afterAll(() => {
  vi.resetModules();
});
