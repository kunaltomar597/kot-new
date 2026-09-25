import { z } from 'zod';

/** A JSON Schema (draft 2020-12) object as emitted by `z.toJSONSchema`. */
export type JsonSchema = Record<string, unknown>;

export const COMPONENT_PREFIX = '#/components/schemas/';
/** Suffix of the component that describes what a client sends when it differs from the parsed form. */
export const INPUT_SUFFIX = 'Input';

/**
 * Every Zod schema exported by the package, keyed by export name in alphabetical order. New
 * schemas are picked up automatically; a schema object exported under two names keeps the first.
 */
export function collectSchemas(
  namespace: Readonly<Record<string, unknown>>,
): Map<string, z.ZodType> {
  const named = new Map<string, z.ZodType>();
  const seen = new Set<z.ZodType>();
  for (const name of Object.keys(namespace).sort()) {
    const value = namespace[name];
    if (value instanceof z.ZodType && !seen.has(value)) {
      seen.add(value);
      named.set(name, value);
    }
  }
  return named;
}

/** Converts one schema on its own, without shared references (used for snapshots and parameters). */
export function toStandaloneJsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  return stripMeta(z.toJSONSchema(schema, { io, unrepresentable: 'any' }));
}

/**
 * Converts named schemas together so that a named schema used inside another becomes a `$ref`
 * to its component instead of being inlined.
 */
export function toJsonSchemas(
  named: ReadonlyMap<string, z.ZodType>,
  io: 'input' | 'output',
  componentName: (name: string) => string = (name) => name,
): Record<string, JsonSchema> {
  const registry = z.registry<{ id: string }>();
  for (const [name, schema] of named) registry.add(schema, { id: name });
  const { schemas } = z.toJSONSchema(registry, {
    io,
    unrepresentable: 'any',
    uri: (id) => COMPONENT_PREFIX + componentName(id),
  });
  const result: Record<string, JsonSchema> = {};
  for (const name of named.keys()) {
    const schema = schemas[name];
    if (schema === undefined) throw new Error(`Schema ${name} was not converted`);
    result[name] = stripMeta(schema);
  }
  return result;
}

export interface Components {
  /** Component schemas keyed by component name. */
  schemas: Record<string, JsonSchema>;
  /** Component to reference for a request body (the input form) of a named schema. */
  inputName(name: string): string;
}

/**
 * Builds shared components for both directions. Most schemas accept exactly what they produce;
 * those that do (defaults, transforms) get an extra `<Name>Input` component describing what a
 * client may send, and every schema that contains one of them does too.
 */
export function buildComponents(named: ReadonlyMap<string, z.ZodType>): Components {
  for (const name of named.keys()) {
    if (name.endsWith(INPUT_SUFFIX) && named.has(name.slice(0, -INPUT_SUFFIX.length))) {
      throw new Error(`Export ${name} collides with the generated input component name`);
    }
  }
  const output = toJsonSchemas(named, 'output');
  let differs = new Set<string>();
  let input: Record<string, JsonSchema>;
  for (;;) {
    const current = differs;
    input = toJsonSchemas(named, 'input', (name) =>
      current.has(name) ? name + INPUT_SUFFIX : name,
    );
    const next = new Set(current);
    for (const name of named.keys()) {
      if (comparable(input[name]) !== comparable(output[name])) next.add(name);
    }
    if (next.size === current.size) break;
    differs = next;
  }
  const schemas: Record<string, JsonSchema> = {};
  for (const [name, schema] of Object.entries(output)) {
    schemas[name] = schema;
    const inputSchema = input[name];
    if (differs.has(name) && inputSchema) schemas[name + INPUT_SUFFIX] = inputSchema;
  }
  return {
    schemas: sortKeys(schemas),
    inputName: (name) => (differs.has(name) ? name + INPUT_SUFFIX : name),
  };
}

/** Keeps only the components reachable through `$ref` from the given roots. */
export function pruneToReachable(
  schemas: Readonly<Record<string, JsonSchema>>,
  roots: Iterable<string>,
): Record<string, JsonSchema> {
  const keep = new Set<string>();
  const pending = [...roots];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (keep.has(name)) continue;
    const schema = schemas[name];
    if (schema === undefined) throw new Error(`Unknown component ${name}`);
    keep.add(name);
    pending.push(...referencedComponents(schema));
  }
  const result: Record<string, JsonSchema> = {};
  for (const [name, schema] of Object.entries(schemas)) {
    if (keep.has(name)) result[name] = schema;
  }
  return sortKeys(result);
}

function referencedComponents(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(referencedComponents);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === '$ref' && typeof child === 'string' && child.startsWith(COMPONENT_PREFIX)
      ? [child.slice(COMPONENT_PREFIX.length)]
      : referencedComponents(child),
  );
}

/**
 * Zod marks plain objects `additionalProperties: false` only in the output form (unknown keys are
 * stripped when parsing). That alone is not worth a separate input component.
 */
function comparable(schema: JsonSchema | undefined): string {
  return JSON.stringify(schema, (key, value: unknown) =>
    key === 'additionalProperties' && value === false ? undefined : value,
  );
}

function stripMeta(schema: JsonSchema): JsonSchema {
  const { $schema: _schema, $id: _id, ...rest } = schema;
  return rest;
}

function sortKeys<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
}
