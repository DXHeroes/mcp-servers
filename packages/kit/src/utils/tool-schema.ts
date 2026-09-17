// Derived from Local MCP Gateway. Elastic License 2.0; see NOTICE.
import { z } from 'zod';
import type { JsonSchema } from '../types/mcp.js';

/**
 * Converted schemas are shared by every caller that asks for the same Zod
 * object, so they are frozen: one consumer mutating the relayed schema would
 * change what every other caller and request sees.
 */
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

const conversionCache = new WeakMap<object, JsonSchema>();

/**
 * Is this a Zod schema rather than a JSON Schema object?
 *
 * Both checks matter. `_zod` is Zod v4's internal marker, and a hand-written
 * JSON Schema could in principle carry a key of that name; a callable `parse`
 * is what actually makes it a schema instance.
 */
export function isZodSchema(value: unknown): value is z.ZodType {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_zod' in value &&
    typeof (value as { parse?: unknown }).parse === 'function'
  );
}

/**
 * A Zod schema as JSON Schema; anything else by reference, untouched.
 *
 * `io: 'input'` is the correct side for a tool's *arguments* — a field with a
 * default is optional on the way in even though it is always present on the way
 * out. `unrepresentable: 'any'` keeps a schema that has no JSON Schema
 * equivalent (a transform, `z.custom()`) from throwing: an unconstrained `{}`
 * for one property is a far better answer than losing the whole tool.
 *
 * `$schema` is dropped. It is a document-level annotation no MCP client reads,
 * while caller-supplied JSON Schema documents retain their own dialect declarations.
 */
export function toolInputJsonSchema(schema: unknown): unknown {
  if (!isZodSchema(schema)) {
    return schema;
  }

  const cached = conversionCache.get(schema);
  if (cached) {
    return cached;
  }

  let converted: JsonSchema;
  try {
    const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
      io: 'input',
      unrepresentable: 'any',
    }) as JsonSchema & { $schema?: string };
    converted = deepFreeze(rest);
  } catch {
    // Nothing usable came out. An empty object schema is the honest fallback:
    // it is valid JSON Schema, it says "no known arguments", and it keeps the
    // tool listed instead of failing the whole `tools/list`.
    converted = deepFreeze({ type: 'object', properties: {} });
  }

  conversionCache.set(schema, converted);
  return converted;
}

/**
 * Normalize a freshly fetched tool set.
 *
 * Returns the input array by reference when nothing needed converting (the
 * common case for JSON Schema authors), so already normalized definitions pay a
 * per-tool type check and nothing else. Tools that do need converting are
 * shallow-copied rather than mutated: the array can be a server instance's own
 * cached `listTools()` result.
 */
export function normalizeToolInputSchemas<T extends { inputSchema?: unknown }>(
  tools: readonly T[],
): T[] {
  let changed = false;
  const normalized = tools.map((tool) => {
    const inputSchema = toolInputJsonSchema(tool.inputSchema);
    if (inputSchema === tool.inputSchema) {
      return tool;
    }
    changed = true;
    return { ...tool, inputSchema };
  });

  return changed ? normalized : (tools as T[]);
}
