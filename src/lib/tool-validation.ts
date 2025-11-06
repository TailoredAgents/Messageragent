type JsonSchema = Record<string, unknown>;

class SchemaValidationError extends Error {
  constructor(message: string, readonly path: string[] = []) {
    super(path.length ? `${path.join('.')} - ${message}` : message);
    this.name = 'SchemaValidationError';
  }
}

function assertNoZodArtifacts(schema: JsonSchema, path: string[]): void {
  if (typeof schema !== 'object' || schema === null) {
    return;
  }

  if ('_def' in schema || 'typeName' in schema) {
    throw new SchemaValidationError('Unexpected Zod metadata present in schema', path);
  }

  for (const [key, value] of Object.entries(schema)) {
    if (typeof value === 'object' && value !== null) {
      assertNoZodArtifacts(value as JsonSchema, [...path, key]);
    }
  }
}

function assertObjectSchema(schema: JsonSchema, path: string[]): void {
  if (schema.type !== 'object') {
    throw new SchemaValidationError('Expected type: "object"', path);
  }

  if (schema.additionalProperties !== false) {
    throw new SchemaValidationError('additionalProperties must be false', path);
  }

  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

  const propertyKeys = Object.keys(properties);

  if (propertyKeys.length !== required.length) {
    throw new SchemaValidationError('required must list every property key', path);
  }

  propertyKeys.forEach((key) => {
    if (!required.includes(key)) {
      throw new SchemaValidationError(`Property "${key}" missing from required array`, path);
    }
  });

  for (const [key, propertySchema] of Object.entries(properties)) {
    const nextPath = [...path, key];
    if (!propertySchema || typeof propertySchema !== 'object') {
      continue;
    }

    const typedSchema = propertySchema as JsonSchema;

    if (typedSchema.type === 'object') {
      assertObjectSchema(typedSchema, nextPath);
      continue;
    }

    if (typedSchema.type === 'array') {
      const items = typedSchema.items as JsonSchema | undefined;
      if (items && items.type === 'object') {
        assertObjectSchema(items, [...nextPath, 'items']);
      }
    }

    const anyOf = typedSchema.anyOf as JsonSchema[] | undefined;
    if (Array.isArray(anyOf)) {
      anyOf.forEach((entry, index) => {
        if (entry && entry.type === 'object') {
          assertObjectSchema(entry, [...nextPath, `anyOf[${index}]`]);
        }
        if (
          entry &&
          entry.type === 'array' &&
          entry.items &&
          typeof entry.items === 'object' &&
          entry.items.type === 'object'
        ) {
          assertObjectSchema(entry.items as JsonSchema, [...nextPath, `anyOf[${index}]`, 'items']);
        }
      });
    }
  }
}

export function validateFunctionToolSchema(toolName: string, schema: unknown): void {
  if (!schema || typeof schema !== 'object') {
    throw new SchemaValidationError(`Tool "${toolName}" does not expose a JSON object schema`);
  }

  const jsonSchema = schema as JsonSchema;
  assertNoZodArtifacts(jsonSchema, []);
  assertObjectSchema(jsonSchema, []);
}

export function validateToolDefinition(tool: { name: string; parameters?: unknown; type?: string }): void {
  if (tool.type !== 'function') {
    return;
  }

  validateFunctionToolSchema(tool.name, tool.parameters);
}
