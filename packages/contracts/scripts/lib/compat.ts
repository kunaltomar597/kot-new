/**
 * Backward compatibility of the client API (UPD-006, P7-04d). A server serves the client API it
 * speaks and the one before it (N-1), so the contracts it builds from must still accept what the
 * older apps send and answer what they can read. This compares the contracts now with a frozen
 * version (`docs/api/compat/client-api-<version>.json`, written by `pnpm contracts:freeze`):
 *
 * - every operation is still there, takes no new required input, still accepts every request the
 *   old contract allowed (a "writer" check: old ⊆ new) and answers only what the old contract
 *   could read (a "reader" check: new ⊆ old), with no new success status;
 * - every domain event is still sent and reads as before; the pagers' messages likewise;
 * - the socket handshake and the pairing QR code too.
 *
 * Apps parse answers with Zod objects, which drop properties they do not know, so a new property
 * in an answer is fine; a new enum value, a property that may now be missing or null, or a new
 * required field in a request is not. The comparison is conservative: a schema it cannot reason
 * about must be unchanged.
 */

export type JsonSchema = boolean | Readonly<Record<string, unknown>>;
type SchemaObject = Readonly<Record<string, unknown>>;

export interface SnapshotParameter {
  readonly name: string;
  readonly in: string;
  readonly required: boolean;
  readonly schema: JsonSchema;
}

export interface SnapshotOperation {
  /** As documented, e.g. `/api/v1/tables/{tableId}`. */
  readonly path: string;
  readonly parameters: readonly SnapshotParameter[];
  readonly body: { readonly required: boolean; readonly schema: JsonSchema } | null;
  /** Success answers by status: the schema, or null for an answer without a body. */
  readonly responses: Readonly<Record<string, JsonSchema | null>>;
}

/** The client API as a frozen file holds it: what the apps send and read, without prose. */
export interface ApiSnapshot {
  /** The client API version, e.g. `1.0`. */
  readonly api: string;
  /** The release that froze it. */
  readonly release: string | null;
  readonly rest: {
    /** By `METHOD /path/{}` (path parameters unnamed, so a renamed one is the same path). */
    readonly operations: Readonly<Record<string, SnapshotOperation>>;
    readonly schemas: Readonly<Record<string, JsonSchema>>;
  };
  readonly events: {
    /** Each message's payload, by message name. */
    readonly messages: Readonly<Record<string, JsonSchema>>;
    readonly schemas: Readonly<Record<string, JsonSchema>>;
  };
}

/** Keywords that only describe; they never decide whether a value is accepted. */
const ANNOTATIONS = new Set([
  'description',
  'title',
  'examples',
  'example',
  'deprecated',
  'default',
  'readOnly',
  'writeOnly',
  '$comment',
]);
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs']);
const SCHEMA_VALUES = new Set(['items', 'additionalProperties', 'propertyNames', 'not']);
const SCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);

function isObject(value: unknown): value is SchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A schema without its annotations and `x-` extensions; values (`const`, `enum`) unchanged. */
export function stripSchema(schema: unknown): JsonSchema {
  if (typeof schema === 'boolean') return schema;
  if (!isObject(schema)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key) || key.startsWith('x-')) continue;
    if (SCHEMA_MAPS.has(key) && isObject(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, inner]) => [name, stripSchema(inner)]),
      );
    } else if (SCHEMA_VALUES.has(key) && (isObject(value) || typeof value === 'boolean')) {
      out[key] = stripSchema(value);
    } else if (SCHEMA_LISTS.has(key) && Array.isArray(value)) {
      out[key] = value.map((inner) => stripSchema(inner));
    } else {
      out[key] = value;
    }
  }
  return out;
}

function stripAll(schemas: unknown): Record<string, JsonSchema> {
  if (!isObject(schemas)) return {};
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [name, stripSchema(schema)]),
  );
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

/** `/api/v1/tables/{tableId}` → `/api/v1/tables/{}`. */
export function pathKey(path: string): string {
  return path.replace(/\{[^}]*\}/g, '{}');
}

function jsonContent(value: unknown): JsonSchema | null {
  if (!isObject(value)) return null;
  const content = value.content;
  if (!isObject(content)) return null;
  const json = content['application/json'];
  return isObject(json) && 'schema' in json ? stripSchema(json.schema) : null;
}

/** The client API in an OpenAPI and an AsyncAPI document, as a snapshot. */
export function snapshotOf(input: {
  readonly api: string;
  readonly release: string | null;
  readonly openapi: unknown;
  readonly asyncapi: unknown;
}): ApiSnapshot {
  const openapi = isObject(input.openapi) ? input.openapi : {};
  const asyncapi = isObject(input.asyncapi) ? input.asyncapi : {};
  const operations: Record<string, SnapshotOperation> = {};
  const paths = isObject(openapi.paths) ? openapi.paths : {};
  for (const [path, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (!isObject(operation)) continue;
      const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
      const responses = isObject(operation.responses) ? operation.responses : {};
      const body = isObject(operation.requestBody) ? operation.requestBody : undefined;
      const bodySchema = body === undefined ? null : jsonContent(body);
      operations[`${method.toUpperCase()} ${pathKey(path)}`] = {
        path,
        parameters: parameters.filter(isObject).map((parameter) => ({
          name: String(parameter.name),
          in: String(parameter.in),
          required: parameter.required === true,
          schema: stripSchema(parameter.schema),
        })),
        body:
          bodySchema === null ? null : { required: body?.required === true, schema: bodySchema },
        responses: Object.fromEntries(
          Object.entries(responses)
            .filter(([status]) => /^2\d\d$/.test(status))
            .map(([status, response]) => [status, jsonContent(response)]),
        ),
      };
    }
  }
  const components = isObject(asyncapi.components) ? asyncapi.components : {};
  const messages = isObject(components.messages) ? components.messages : {};
  return {
    api: input.api,
    release: input.release,
    rest: {
      operations,
      schemas: stripAll(isObject(openapi.components) ? openapi.components.schemas : undefined),
    },
    events: {
      messages: Object.fromEntries(
        Object.entries(messages)
          .filter(([, message]) => isObject(message))
          .map(([name, message]) => [name, stripSchema((message as SchemaObject).payload)]),
      ),
      schemas: stripAll(components.schemas),
    },
  };
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => key in b && deepEqual(a[key], b[key]));
  }
  return false;
}

/** Whether two snapshots describe the same client API (the release that froze them aside). */
export function sameApi(a: ApiSnapshot, b: ApiSnapshot): boolean {
  return deepEqual(a.rest, b.rest) && deepEqual(a.events, b.events);
}

// ---------------------------------------------------------------- comparing two schemas

/**
 * `reader`: an old app reads what the new side produces (answers, events); `writer`: the new
 * side reads what an old app sends (requests, the handshake).
 */
type Mode = 'reader' | 'writer';

const HANDLED = new Set([
  '$ref',
  'type',
  'const',
  'enum',
  'anyOf',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
]);
const REF_PREFIX = '#/components/schemas/';
const MAX_DEPTH = 64;

function typesOf(schema: SchemaObject): Set<string> | undefined {
  const type = schema.type;
  if (typeof type === 'string') return new Set([type]);
  if (Array.isArray(type)) return new Set(type.map(String));
  return undefined;
}

function valuesOf(schema: SchemaObject): readonly unknown[] | undefined {
  if ('const' in schema) return [schema.const];
  return Array.isArray(schema.enum) ? schema.enum : undefined;
}

function num(schema: SchemaObject, key: string): number | undefined {
  const value = schema[key];
  return typeof value === 'number' ? value : undefined;
}

function show(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join(', ');
}

function typeOfValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** Every value the left schema allows is allowed by the right one, as far as can be told. */
class SchemaComparison {
  /** Results by pair of component names; a pair being compared counts as fine (recursion). */
  private readonly memo = new Map<string, string[]>();

  constructor(
    private readonly left: Readonly<Record<string, JsonSchema>>,
    private readonly right: Readonly<Record<string, JsonSchema>>,
    private readonly mode: Mode,
  ) {}

  covers(a: JsonSchema, b: JsonSchema, at: string, depth = 0): string[] {
    if (depth > MAX_DEPTH) return [`${at}: too deeply nested to compare`];
    if (b === true || a === false) return [];
    if (b === false) return [`${at}: no value is accepted any more`];
    const left = a === true ? {} : a;
    const leftRef = typeof left.$ref === 'string' ? left.$ref : undefined;
    const rightRef = typeof b.$ref === 'string' ? b.$ref : undefined;
    if (leftRef !== undefined && rightRef !== undefined) {
      const key = `${leftRef}|${rightRef}`;
      const known = this.memo.get(key);
      if (known !== undefined) return known;
      this.memo.set(key, []);
      const result = this.covers(
        this.resolve(this.left, leftRef, at),
        this.resolve(this.right, rightRef, at),
        at,
        depth + 1,
      );
      this.memo.set(key, result);
      return result;
    }
    if (leftRef !== undefined) {
      return this.covers(this.resolve(this.left, leftRef, at), b, at, depth + 1);
    }
    if (rightRef !== undefined) {
      return this.covers(left, this.resolve(this.right, rightRef, at), at, depth + 1);
    }
    return this.compare(left, b, at, depth);
  }

  private resolve(schemas: Readonly<Record<string, JsonSchema>>, ref: string, at: string) {
    const schema = ref.startsWith(REF_PREFIX) ? schemas[ref.slice(REF_PREFIX.length)] : undefined;
    if (schema === undefined) throw new Error(`${at}: cannot resolve ${ref}`);
    return schema;
  }

  private compare(a: SchemaObject, b: SchemaObject, at: string, depth: number): string[] {
    // A union on the left: each of its branches must be accepted.
    const leftBranches = a.anyOf ?? a.oneOf;
    if (Array.isArray(leftBranches)) {
      const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = a;
      return leftBranches.flatMap((branch: JsonSchema) =>
        this.covers(merge(rest, branch), b, at, depth + 1),
      );
    }
    // Known values on the left: check each one against the right.
    const values = valuesOf(a);
    if (values !== undefined) {
      const refused = values.filter((value) => !this.allows(b, value, depth + 1));
      if (refused.length === 0) return [];
      return [
        this.mode === 'reader'
          ? `${at}: ${show(refused)} can now be sent, which older apps refuse`
          : `${at}: ${show(refused)} is no longer accepted`,
      ];
    }
    // A union on the right: one of its branches must accept the left.
    const rightBranches = b.anyOf ?? b.oneOf;
    if (Array.isArray(rightBranches)) {
      const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = b;
      let best: string[] | undefined;
      for (const branch of rightBranches as JsonSchema[]) {
        const problems = this.covers(a, merge(rest, branch), at, depth + 1);
        if (problems.length === 0) return [];
        if (best === undefined || problems.length < best.length) best = problems;
      }
      return best ?? [`${at}: no value is accepted any more`];
    }
    const rightValues = valuesOf(b);
    if (rightValues !== undefined) {
      return [
        this.mode === 'reader'
          ? `${at}: only ${show(rightValues)} could be sent before; now other values can`
          : `${at}: only ${show(rightValues)} is accepted now`,
      ];
    }
    const problems: string[] = [];
    for (const key of Object.keys(b)) {
      if (!HANDLED.has(key) && !deepEqual(a[key], b[key])) {
        problems.push(`${at}: "${key}" changed and cannot be compared`);
      }
    }
    const leftTypes = typesOf(a);
    const rightTypes = typesOf(b);
    if (rightTypes !== undefined) {
      if (leftTypes === undefined) {
        problems.push(`${at}: any type was allowed, now only ${[...rightTypes].join(' or ')}`);
        return problems;
      }
      for (const type of leftTypes) {
        if (rightTypes.has(type) || (type === 'integer' && rightTypes.has('number'))) continue;
        problems.push(
          this.mode === 'reader'
            ? `${at}: can now be ${type}, which older apps refuse`
            : `${at}: ${type} is no longer accepted`,
        );
      }
    }
    const types = leftTypes ?? new Set(['string', 'number', 'integer', 'array', 'object']);
    if (types.has('string')) problems.push(...this.strings(a, b, at));
    if (types.has('number') || types.has('integer')) problems.push(...this.numbers(a, b, at));
    if (types.has('array')) problems.push(...this.arrays(a, b, at, depth));
    if (types.has('object')) problems.push(...this.objects(a, b, at, depth));
    return problems;
  }

  private narrower(at: string, what: string): string {
    return this.mode === 'reader'
      ? `${at}: ${what} is looser now, so older apps may refuse it`
      : `${at}: ${what} is stricter now`;
  }

  private strings(a: SchemaObject, b: SchemaObject, at: string): string[] {
    const problems: string[] = [];
    if ((num(a, 'minLength') ?? 0) < (num(b, 'minLength') ?? 0)) {
      problems.push(this.narrower(at, 'the shortest length'));
    }
    const max = num(b, 'maxLength');
    const leftMax = num(a, 'maxLength');
    if (max !== undefined && (leftMax === undefined || leftMax > max)) {
      problems.push(this.narrower(at, 'the longest length'));
    }
    if (b.pattern !== undefined && a.pattern !== b.pattern) {
      problems.push(this.narrower(at, 'the pattern'));
    }
    if (b.format !== undefined && a.format !== b.format) {
      problems.push(this.narrower(at, 'the format'));
    }
    return problems;
  }

  private numbers(a: SchemaObject, b: SchemaObject, at: string): string[] {
    const problems: string[] = [];
    const lowest = (s: SchemaObject) => {
      const minimum = num(s, 'minimum');
      const exclusive = num(s, 'exclusiveMinimum');
      if (exclusive !== undefined && (minimum === undefined || exclusive >= minimum)) {
        return { value: exclusive, exclusive: true };
      }
      return minimum === undefined ? undefined : { value: minimum, exclusive: false };
    };
    const highest = (s: SchemaObject) => {
      const maximum = num(s, 'maximum');
      const exclusive = num(s, 'exclusiveMaximum');
      if (exclusive !== undefined && (maximum === undefined || exclusive <= maximum)) {
        return { value: exclusive, exclusive: true };
      }
      return maximum === undefined ? undefined : { value: maximum, exclusive: false };
    };
    const [low, rightLow] = [lowest(a), lowest(b)];
    if (
      rightLow !== undefined &&
      (low === undefined ||
        low.value < rightLow.value ||
        (low.value === rightLow.value && rightLow.exclusive && !low.exclusive))
    ) {
      problems.push(this.narrower(at, 'the lowest value'));
    }
    const [high, rightHigh] = [highest(a), highest(b)];
    if (
      rightHigh !== undefined &&
      (high === undefined ||
        high.value > rightHigh.value ||
        (high.value === rightHigh.value && rightHigh.exclusive && !high.exclusive))
    ) {
      problems.push(this.narrower(at, 'the highest value'));
    }
    const step = num(b, 'multipleOf');
    const leftStep = num(a, 'multipleOf');
    if (step !== undefined && (leftStep === undefined || leftStep % step !== 0)) {
      problems.push(this.narrower(at, 'the step'));
    }
    return problems;
  }

  private arrays(a: SchemaObject, b: SchemaObject, at: string, depth: number): string[] {
    const problems: string[] = [];
    if ((num(a, 'minItems') ?? 0) < (num(b, 'minItems') ?? 0)) {
      problems.push(this.narrower(at, 'the fewest items'));
    }
    const max = num(b, 'maxItems');
    const leftMax = num(a, 'maxItems');
    if (max !== undefined && (leftMax === undefined || leftMax > max)) {
      problems.push(this.narrower(at, 'the most items'));
    }
    if (Array.isArray(b.prefixItems)) {
      const left = Array.isArray(a.prefixItems) ? (a.prefixItems as JsonSchema[]) : [];
      (b.prefixItems as JsonSchema[]).forEach((item, index) => {
        problems.push(
          ...this.covers(left[index] ?? true, item, `${at}[${String(index)}]`, depth + 1),
        );
      });
    }
    if (b.items !== undefined) {
      problems.push(
        ...this.covers(
          (a.items as JsonSchema | undefined) ?? true,
          b.items as JsonSchema,
          `${at}[]`,
          depth + 1,
        ),
      );
    }
    return problems;
  }

  private objects(a: SchemaObject, b: SchemaObject, at: string, depth: number): string[] {
    const problems: string[] = [];
    const leftProperties = isObject(a.properties) ? a.properties : {};
    const rightProperties = isObject(b.properties) ? b.properties : {};
    const leftRequired = new Set(Array.isArray(a.required) ? a.required.map(String) : []);
    const rightRequired = Array.isArray(b.required) ? b.required.map(String) : [];
    for (const name of rightRequired) {
      if (leftRequired.has(name)) continue;
      problems.push(
        this.mode === 'reader'
          ? `${at}.${name} may now be missing, which older apps refuse`
          : `${at}.${name} is required now, and older apps do not send it`,
      );
    }
    const extra = b.additionalProperties;
    for (const [name, schema] of Object.entries(leftProperties)) {
      const inner = `${at}.${name}`;
      const right = rightProperties[name];
      if (right !== undefined) {
        problems.push(...this.covers(schema as JsonSchema, right as JsonSchema, inner, depth + 1));
      } else if (isObject(extra)) {
        problems.push(...this.covers(schema as JsonSchema, extra, inner, depth + 1));
      } else if (extra === false && this.mode === 'writer') {
        // Answers may carry properties an app does not know: Zod drops them. Requests may not.
        problems.push(`${inner} is no longer accepted`);
      }
    }
    // Any other property (a record): the right must take it too.
    const leftExtra = a.additionalProperties;
    if (isObject(leftExtra) || leftExtra === true) {
      if (isObject(extra)) {
        problems.push(...this.covers(leftExtra, extra, `${at}[*]`, depth + 1));
      } else if (extra === false && this.mode === 'writer') {
        problems.push(`${at}: other properties are no longer accepted`);
      }
    }
    if (b.propertyNames !== undefined) {
      if (a.propertyNames !== undefined) {
        problems.push(
          ...this.covers(
            a.propertyNames as JsonSchema,
            b.propertyNames as JsonSchema,
            `${at} keys`,
            depth + 1,
          ),
        );
      } else if (isObject(leftExtra) || leftExtra === true) {
        problems.push(this.narrower(`${at} keys`, 'the names allowed'));
      }
    }
    return problems;
  }

  /** Whether a schema on the right accepts one known value (from `const` or `enum`). */
  private allows(schema: JsonSchema, value: unknown, depth: number): boolean {
    if (typeof schema === 'boolean') return schema;
    if (depth > MAX_DEPTH) return false;
    if (typeof schema.$ref === 'string') {
      return this.allows(this.resolve(this.right, schema.$ref, 'value'), value, depth + 1);
    }
    const branches = schema.anyOf ?? schema.oneOf;
    if (Array.isArray(branches)) {
      const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = schema;
      return (branches as JsonSchema[]).some((branch) =>
        this.allows(merge(rest, branch), value, depth + 1),
      );
    }
    const values = valuesOf(schema);
    if (values !== undefined) return values.some((allowed) => deepEqual(allowed, value));
    const types = typesOf(schema);
    const type = typeOfValue(value);
    if (types !== undefined && !types.has(type) && !(type === 'integer' && types.has('number'))) {
      return false;
    }
    if (typeof value === 'string') {
      // JSON Schema counts code points.
      const length = Array.from(value).length;
      if (length < (num(schema, 'minLength') ?? 0)) return false;
      if (length > (num(schema, 'maxLength') ?? Infinity)) return false;
      if (typeof schema.pattern === 'string' && !matches(schema.pattern, value)) return false;
    }
    if (typeof value === 'number') {
      if (value < (num(schema, 'minimum') ?? -Infinity)) return false;
      if (value > (num(schema, 'maximum') ?? Infinity)) return false;
      const low = num(schema, 'exclusiveMinimum');
      const high = num(schema, 'exclusiveMaximum');
      if ((low !== undefined && value <= low) || (high !== undefined && value >= high))
        return false;
    }
    return true;
  }
}

/** JSON Schema patterns are ECMAScript expressions; Zod's are not always valid with `u`. */
function matches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, 'u').test(value);
  } catch {
    return new RegExp(pattern).test(value);
  }
}

function merge(rest: SchemaObject, branch: JsonSchema): JsonSchema {
  if (typeof branch === 'boolean' || Object.keys(rest).length === 0) return branch;
  return { ...rest, ...branch };
}

// ---------------------------------------------------------------- comparing two client APIs

/** Device → server messages among the AsyncAPI document's; every other message is read by apps. */
const MESSAGES_TO_SERVER = new Set(['PagerAckMessage', 'PagerHeartbeat']);
/** Socket and pairing schemas outside the routes: apps send these... */
const SENT_BY_APPS = ['RealtimeHandshake', 'RealtimeResyncRequest'];
/** ...and read these. */
const READ_BY_APPS = ['RealtimeSync', 'RealtimeHead', 'RealtimeEnded', 'PairingQrPayload'];

/**
 * What would break apps built against `frozen` if the server were built from `current`. Empty
 * when the current contracts still serve them.
 */
export function compatibilityProblems(frozen: ApiSnapshot, current: ApiSnapshot): string[] {
  const writer = new SchemaComparison(frozen.rest.schemas, current.rest.schemas, 'writer');
  const reader = new SchemaComparison(current.rest.schemas, frozen.rest.schemas, 'reader');
  const problems: string[] = [];
  for (const [key, old] of Object.entries(frozen.rest.operations)) {
    const now = current.rest.operations[key];
    if (now === undefined) {
      problems.push(`${key}: removed`);
      continue;
    }
    problems.push(...operationProblems(key, old, now, writer, reader));
  }
  for (const name of SENT_BY_APPS) {
    const [old, now] = [frozen.rest.schemas[name], current.rest.schemas[name]];
    if (old === undefined) continue;
    if (now === undefined) problems.push(`${name}: removed`);
    else problems.push(...writer.covers(old, now, name));
  }
  for (const name of READ_BY_APPS) {
    const [old, now] = [frozen.rest.schemas[name], current.rest.schemas[name]];
    if (old === undefined) continue;
    if (now === undefined) problems.push(`${name}: removed`);
    else problems.push(...reader.covers(now, old, name));
  }
  const eventWriter = new SchemaComparison(frozen.events.schemas, current.events.schemas, 'writer');
  const eventReader = new SchemaComparison(current.events.schemas, frozen.events.schemas, 'reader');
  for (const [name, old] of Object.entries(frozen.events.messages)) {
    const now = current.events.messages[name];
    const at = `event ${name}`;
    if (now === undefined) problems.push(`${at}: no longer sent`);
    else if (MESSAGES_TO_SERVER.has(name)) problems.push(...eventWriter.covers(old, now, at));
    else problems.push(...eventReader.covers(now, old, at));
  }
  return problems;
}

function operationProblems(
  key: string,
  old: SnapshotOperation,
  now: SnapshotOperation,
  writer: SchemaComparison,
  reader: SchemaComparison,
): string[] {
  const problems: string[] = [];
  // Path parameters are matched by position (they may be renamed); the rest by name.
  const id = (parameter: SnapshotParameter, index: number, all: readonly SnapshotParameter[]) =>
    parameter.in === 'path'
      ? `path#${String(all.filter((p, i) => p.in === 'path' && i < index).length)}`
      : `${parameter.in}:${parameter.name}`;
  const before = new Map(old.parameters.map((p, i, all) => [id(p, i, all), p]));
  const after = new Map(now.parameters.map((p, i, all) => [id(p, i, all), p]));
  for (const [name, parameter] of after) {
    const previous = before.get(name);
    if (parameter.required && previous?.required !== true) {
      problems.push(`${key}: ${parameter.in} parameter "${parameter.name}" is required now`);
    }
  }
  for (const [name, parameter] of before) {
    const next = after.get(name);
    const at = `${key} ${parameter.in} parameter "${parameter.name}"`;
    if (next === undefined) problems.push(`${at}: no longer accepted`);
    else problems.push(...writer.covers(parameter.schema, next.schema, at));
  }
  if (old.body !== null) {
    if (now.body === null) problems.push(`${key}: the request body is no longer read`);
    else problems.push(...writer.covers(old.body.schema, now.body.schema, `${key} body`));
  } else if (now.body?.required === true) {
    problems.push(`${key}: a request body is required now`);
  }
  for (const [status, schema] of Object.entries(now.responses)) {
    if (!(status in old.responses)) {
      problems.push(`${key}: answers ${status}, which older apps do not expect`);
      continue;
    }
    const previous = old.responses[status] ?? null;
    if (previous === null) continue;
    if (schema === null) problems.push(`${key} ${status}: the answer has no body now`);
    else problems.push(...reader.covers(schema, previous, `${key} ${status}`));
  }
  return problems;
}
