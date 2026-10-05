/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment -- the tests edit generated JSON documents freely (Doc) */
import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';
import { buildAsyncApi } from '../scripts/lib/asyncapi.js';
import {
  type ApiSnapshot,
  compatibilityProblems,
  type JsonSchema,
  pathKey,
  sameApi,
  snapshotOf,
  type SnapshotOperation,
  stripSchema,
} from '../scripts/lib/compat.js';
import { buildOpenApi } from '../scripts/lib/openapi.js';

// The tests edit the generated documents as plain JSON, path by path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
type Doc = Record<string, any>;

const openapi = buildOpenApi({ namespace: contracts, routes: contracts.ROUTES, version: '0.0.0' });
const asyncapi = buildAsyncApi({
  namespace: contracts,
  events: contracts.DomainEvent,
  version: '0.0.0',
});

const snapshot = (open: unknown = openapi, async: unknown = asyncapi): ApiSnapshot =>
  snapshotOf({ api: '1.0', release: '1.0.0', openapi: open, asyncapi: async });
const frozen = snapshot();
const copy = (doc: unknown): Doc => structuredClone(doc) as Doc;
/** The problems a change to the documents brings, against the contracts as they are. */
const after = (change: (open: Doc, async: Doc) => void): string[] => {
  const [open, async] = [copy(openapi), copy(asyncapi)];
  change(open, async);
  return compatibilityProblems(frozen, snapshot(open, async));
};

describe('[UPD-006] the client API snapshot', () => {
  it('keeps what apps send and read, without prose', () => {
    const stripped = stripSchema({
      type: 'object',
      description: 'prose',
      'x-capability': 'PUBLIC',
      default: {},
      properties: { description: { type: 'string', title: 'kept as a property' } },
      anyOf: [{ const: 'x', description: 'gone' }],
      enum: [{ description: 'a value, kept' }],
    });
    expect(stripped).toEqual({
      type: 'object',
      properties: { description: { type: 'string' } },
      anyOf: [{ const: 'x' }],
      enum: [{ description: 'a value, kept' }],
    });
  });

  it('lists every operation, its success answers and every event', () => {
    expect(Object.keys(frozen.rest.operations)).toHaveLength(contracts.ROUTES.length);
    const version = frozen.rest.operations['GET /api/v1/version'];
    expect(version?.responses).toEqual({
      '200': { $ref: '#/components/schemas/VersionResponse' },
    });
    expect(frozen.events.messages.MenuPublished).toEqual({
      $ref: '#/components/schemas/MenuPublished',
    });
    expect(pathKey('/api/v1/tables/{tableId}/move')).toBe('/api/v1/tables/{}/move');
  });

  it('is the same API when only prose changed', () => {
    const open = copy(openapi);
    open.info.description = 'Other words';
    open.components.schemas.VersionResponse.description = 'Other words';
    expect(sameApi(frozen, snapshot(open))).toBe(true);
    open.components.schemas.VersionResponse.properties.extra = { type: 'string' };
    expect(sameApi(frozen, snapshot(open))).toBe(false);
  });
});

describe('[UPD-006] the contracts serve apps one client API behind (N-1)', () => {
  it('finds nothing when nothing changed', () => {
    expect(compatibilityProblems(frozen, snapshot())).toEqual([]);
  });

  it('allows what older apps never notice', () => {
    expect(
      after((open, async) => {
        const schemas = open.components.schemas;
        // A new route, a new optional request field, a new answer field, a looser request limit.
        open.paths['/api/v1/new-thing'] = copy(open.paths['/api/v1/version']);
        schemas.PairDeviceRequest.properties.label = { type: 'string' };
        schemas.VersionResponse.properties.uptime = { type: 'integer' };
        schemas.PairDeviceRequest.properties.appVersion.maxLength = 80;
        // A new event type and a new optional field in an event.
        async.components.messages.SomethingNew = { payload: { type: 'object' } };
        async.components.schemas.MenuPublished.properties.extra = { type: 'string' };
      }),
    ).toEqual([]);
  });

  it('refuses a removed route', () => {
    expect(
      after((open) => {
        delete open.paths['/api/v1/version'];
      }),
    ).toEqual(['GET /api/v1/{}: removed'.replace('{}', 'version')]);
  });

  it('refuses a new enum value in an answer', () => {
    const problems = after((open) => {
      open.components.schemas.DeviceStatus.enum.push('LOST');
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain('"LOST" can now be sent, which older apps refuse');
  });

  it('refuses an answer field that may now be missing or null', () => {
    const missing = after((open) => {
      const required: string[] = open.components.schemas.VersionResponse.required;
      required.splice(required.indexOf('node'), 1);
    });
    expect(missing).toEqual([
      'GET /api/v1/version 200.node may now be missing, which older apps refuse',
    ]);
    const nullable = after((open) => {
      open.components.schemas.VersionResponse.properties.node = {
        type: ['string', 'null'],
        minLength: 1,
      };
    });
    expect(nullable).toEqual([
      'GET /api/v1/version 200.node: can now be null, which older apps refuse',
    ]);
  });

  it('refuses a new required request field, or a removed one', () => {
    const required = after((open) => {
      const schema = open.components.schemas.PairDeviceRequest;
      schema.properties.label = { type: 'string' };
      schema.required.push('label');
    });
    expect(required).toContain(
      'POST /api/v1/devices/pair body.label is required now, and older apps do not send it',
    );
    const removed = after((open) => {
      delete open.components.schemas.PairDeviceRequest.properties.appVersion;
    });
    expect(removed).toContain('POST /api/v1/devices/pair body.appVersion is no longer accepted');
  });

  it('refuses a stricter request limit or a narrower type', () => {
    const problems = after((open) => {
      const schema = open.components.schemas.PairDeviceRequest;
      schema.properties.appVersion.maxLength = 20;
      schema.properties.appVersion.minLength = 3;
    });
    expect(problems).toEqual([
      'POST /api/v1/devices/pair body.appVersion: the shortest length is stricter now',
      'POST /api/v1/devices/pair body.appVersion: the longest length is stricter now',
    ]);
  });

  it('refuses a new required query parameter and a new success status', () => {
    const problems = after((open) => {
      const operation = open.paths['/api/v1/version'].get;
      operation.parameters = [
        { name: 'detail', in: 'query', required: true, schema: { type: 'string' } },
      ];
      operation.responses['201'] = operation.responses['200'];
    });
    expect(problems).toEqual([
      'GET /api/v1/version: query parameter "detail" is required now',
      'GET /api/v1/version: answers 201, which older apps do not expect',
    ]);
  });

  it('refuses an event that is no longer sent or reads differently', () => {
    const problems = after((_open, async) => {
      delete async.components.messages.TableMoved;
      async.components.schemas.MenuPublished.properties.payload = { type: 'string' };
    });
    expect(problems).toContain('event TableMoved: no longer sent');
    expect(problems.some((problem) => problem.startsWith('event MenuPublished'))).toBe(true);
  });

  it('refuses a pager heartbeat field the server no longer takes', () => {
    const problems = after((_open, async) => {
      const heartbeat = async.components.schemas.PagerHeartbeat;
      delete heartbeat.properties.rssi;
      heartbeat.required = heartbeat.required.filter((name: string) => name !== 'rssi');
    });
    expect(problems).toEqual(['event PagerHeartbeat.rssi is no longer accepted']);
  });

  it('refuses a socket handshake field the server no longer takes', () => {
    const problems = after((open) => {
      delete open.components.schemas.RealtimeHandshake.properties.streamId;
    });
    expect(problems).toEqual(['RealtimeHandshake.streamId is no longer accepted']);
  });
});

describe('[UPD-006] comparing schemas', () => {
  const op = (body: JsonSchema | null, answer: JsonSchema | null): SnapshotOperation => ({
    path: '/x',
    parameters: [],
    body: body === null ? null : { required: true, schema: body },
    responses: { '200': answer },
  });
  const api = (operation: SnapshotOperation, schemas: Record<string, JsonSchema> = {}) =>
    ({
      api: '1.0',
      release: null,
      rest: { operations: { 'POST /x': operation }, schemas },
      events: { messages: {}, schemas: {} },
    }) satisfies ApiSnapshot;
  const answer = (before: JsonSchema, now: JsonSchema, schemas?: [object, object]) =>
    compatibilityProblems(
      api(op(null, before), schemas?.[0] as Record<string, JsonSchema>),
      api(op(null, now), schemas?.[1] as Record<string, JsonSchema>),
    );
  const request = (before: JsonSchema, now: JsonSchema) =>
    compatibilityProblems(api(op(before, null)), api(op(now, null)));

  it('reads unions branch by branch', () => {
    const union = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
    expect(answer(union, { type: 'string' })).toEqual([]);
    expect(answer({ type: 'string' }, union)).toEqual([
      'POST /x 200: can now be integer, which older apps refuse',
    ]);
    expect(request({ type: 'integer' }, { anyOf: [{ type: 'number' }, { type: 'null' }] })).toEqual(
      [],
    );
  });

  it('checks known values against unions of constants and patterns', () => {
    const choices = { anyOf: [{ const: 'A' }, { const: 'B' }] };
    expect(answer(choices, { enum: ['A'] })).toEqual([]);
    expect(answer(choices, { enum: ['A', 'C'] })).toEqual([
      'POST /x 200: "C" can now be sent, which older apps refuse',
    ]);
    expect(request({ type: 'string', pattern: '^[A-Z]+$' }, { const: 'AB' })).toEqual([
      'POST /x body: only "AB" is accepted now',
    ]);
    expect(answer({ type: 'string', pattern: '^[A-Z]+$', maxLength: 2 }, { const: 'AB' })).toEqual(
      [],
    );
    expect(answer({ type: 'string', pattern: '^[A-Z]+$' }, { const: 'ab' })).toHaveLength(1);
  });

  it('follows references, also recursive ones', () => {
    const tree = (extra: object) => ({
      Tree: {
        type: 'object',
        properties: {
          name: { type: 'string', ...extra },
          children: { type: 'array', items: { $ref: '#/components/schemas/Tree' } },
        },
        required: ['name', 'children'],
      },
    });
    const ref = { $ref: '#/components/schemas/Tree' };
    expect(answer(ref, ref, [tree({}), tree({})])).toEqual([]);
    expect(answer(ref, ref, [tree({ maxLength: 5 }), tree({})])).toEqual([
      'POST /x 200.name: the longest length is looser now, so older apps may refuse it',
    ]);
  });

  it('compares records, tuples, arrays and numbers', () => {
    const record = (value: object, names?: object) => ({
      type: 'object',
      additionalProperties: value,
      ...(names !== undefined && { propertyNames: names }),
    });
    expect(answer(record({ type: 'integer' }), record({ type: 'integer', minimum: 0 }))).toEqual(
      [],
    );
    expect(answer(record({ type: 'integer' }), record({ type: 'number' }))).toEqual([
      'POST /x 200[*]: can now be number, which older apps refuse',
    ]);
    expect(answer(record({}, { type: 'string', pattern: '^[A-Z]+$' }), record({}))).toEqual([
      'POST /x 200 keys: the names allowed is looser now, so older apps may refuse it',
    ]);
    expect(
      request(
        { type: 'array', prefixItems: [{ type: 'string' }, { type: 'string', maxLength: 12 }] },
        { type: 'array', prefixItems: [{ type: 'string' }, { type: 'string', maxLength: 10 }] },
      ),
    ).toEqual(['POST /x body[1]: the longest length is stricter now']);
    expect(
      request(
        { type: 'array', items: { type: 'string' }, maxItems: 5 },
        { type: 'array', items: { type: 'string' }, maxItems: 3 },
      ),
    ).toEqual(['POST /x body: the most items is stricter now']);
    expect(
      request({ type: 'integer', minimum: 1 }, { type: 'integer', exclusiveMinimum: 0 }),
    ).toEqual([]);
    expect(
      request({ type: 'integer', minimum: 0 }, { type: 'integer', exclusiveMinimum: 0 }),
    ).toEqual(['POST /x body: the lowest value is stricter now']);
    expect(
      request({ type: 'integer', maximum: 10 }, { type: 'integer', exclusiveMaximum: 10 }),
    ).toEqual(['POST /x body: the highest value is stricter now']);
  });

  it('keeps a schema it cannot reason about unchanged', () => {
    expect(
      request({ type: 'string', not: { const: 'x' } }, { type: 'string', not: { const: 'y' } }),
    ).toEqual(['POST /x body: "not" changed and cannot be compared']);
    expect(request({ type: 'string' }, false)).toEqual([
      'POST /x body: no value is accepted any more',
    ]);
  });
});
