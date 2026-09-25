import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as contracts from '../src/index.js';
import { buildAsyncApi } from '../scripts/lib/asyncapi.js';
import { buildOpenApi } from '../scripts/lib/openapi.js';
import { renderDocs } from '../scripts/lib/render.js';
import { collectSchemas } from '../scripts/lib/schema-catalog.js';
import type { RouteDefinition } from '../src/routes.js';

const outDir = fileURLToPath(new URL('../../../docs/api/', import.meta.url));
const options = {
  namespace: contracts,
  routes: contracts.ROUTES,
  events: contracts.DomainEvent,
  version: '0.0.0-test',
  outDir,
};

interface Doc {
  paths: Record<string, Record<string, { requestBody?: unknown; parameters?: unknown[] }>>;
  components: { schemas: Record<string, unknown>; messages: Record<string, unknown> };
  channels: Record<string, unknown>;
}
const openapi = buildOpenApi(options) as unknown as Doc;
const asyncapi = buildAsyncApi(options) as unknown as Doc;

const route = (overrides: Partial<RouteDefinition>): RouteDefinition => ({
  operationId: 'getThing',
  method: 'GET',
  path: '/api/v1/things/:thingId',
  summary: 'Get a thing',
  tags: ['things'],
  requirements: [],
  capability: 'PUBLIC',
  request: { params: z.object({ thingId: contracts.Id }) },
  responses: { 200: { description: 'The thing', schema: contracts.Station } },
  ...overrides,
});

describe('[INT-002] [NFR-M06] generated contract documents', () => {
  it('renders deterministically', async () => {
    const first = await renderDocs(options);
    const second = await renderDocs(options);
    expect(second).toEqual(first);
    expect(first.map((file) => file.name)).toEqual(['openapi.json', 'asyncapi.yaml']);
  });

  it('documents every exported schema as an OpenAPI component', () => {
    for (const name of collectSchemas(contracts).keys()) {
      expect(openapi.components.schemas).toHaveProperty([name]);
    }
  });

  it('documents every registered route', () => {
    for (const registered of contracts.ROUTES) {
      // OpenAPI writes Express-style `:param` as `{param}`.
      const path = registered.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      expect(openapi.paths[path]?.[registered.method.toLowerCase()], path).toBeDefined();
    }
  });

  it('[ORD-014] describes the order request as clients send it, without price fields', () => {
    const body = openapi.paths['/api/v1/orders']?.post?.requestBody;
    expect(JSON.stringify(body)).toContain('SubmitOrderRequestInput');
    const line = openapi.components.schemas.OrderLineRequestInput as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(line.required).not.toContain('modifiers');
    expect(Object.keys(line.properties).some((key) => /price/i.test(key))).toBe(false);
  });

  it('[INT-004] documents every domain event as an AsyncAPI message', () => {
    for (const type of contracts.DOMAIN_EVENT_TYPES) {
      expect(asyncapi.channels).toHaveProperty([type]);
      expect(asyncapi.components.messages).toHaveProperty([type]);
      expect(asyncapi.components.schemas).toHaveProperty([type]);
    }
    // Only schemas reachable from events are included.
    expect(asyncapi.components.schemas).not.toHaveProperty(['SubmitOrderRequest']);
  });

  it('turns path parameters into OpenAPI parameters', () => {
    const doc = buildOpenApi({ ...options, routes: [route({})] }) as unknown as Doc;
    expect(doc.paths['/api/v1/things/{thingId}']?.get?.parameters).toEqual([
      expect.objectContaining({ name: 'thingId', in: 'path', required: true }),
    ]);
  });

  it('adds query parameters with their optionality', () => {
    const doc = buildOpenApi({
      ...options,
      routes: [
        route({
          request: {
            params: z.object({ thingId: contracts.Id }),
            query: z.object({ limit: z.int().optional(), channel: contracts.SalesChannel }),
          },
        }),
      ],
    }) as unknown as Doc;
    expect(doc.paths['/api/v1/things/{thingId}']?.get?.parameters).toEqual([
      expect.objectContaining({ name: 'thingId', in: 'path' }),
      expect.objectContaining({ name: 'channel', in: 'query', required: true }),
      expect.objectContaining({ name: 'limit', in: 'query', required: false }),
    ]);
  });

  it('rejects routes whose schemas are not exported', () => {
    const inline = route({ responses: { 200: { description: 'x', schema: z.object({}) } } });
    expect(() => buildOpenApi({ ...options, routes: [inline] })).toThrow(/not exported/);
  });

  it('rejects mismatched path parameters and duplicate routes', () => {
    expect(() => buildOpenApi({ ...options, routes: [route({ request: {} })] })).toThrow(
      /path parameters/,
    );
    expect(() => buildOpenApi({ ...options, routes: [route({}), route({})] })).toThrow(
      /Duplicate operationId/,
    );
    expect(() =>
      buildOpenApi({ ...options, routes: [route({}), route({ operationId: 'other' })] }),
    ).toThrow(/Duplicate route/);
  });

  it('names events that are only defined inside the catalogue after their type', () => {
    const Inline = z.object({
      type: z.literal('SomethingHappened'),
      version: z.literal(1),
      payload: z.object({ id: contracts.Id }),
    });
    const doc = buildAsyncApi({
      ...options,
      events: z.discriminatedUnion('type', [Inline]),
    }) as unknown as Doc;
    expect(Object.keys(doc.components.schemas)).toEqual(['Id', 'SomethingHappened']);
  });

  it('rejects events without literal type and version', () => {
    const noVersion = z.discriminatedUnion('type', [z.object({ type: z.literal('X') })]);
    expect(() => buildAsyncApi({ ...options, events: noVersion })).toThrow(/version/);
  });
});
