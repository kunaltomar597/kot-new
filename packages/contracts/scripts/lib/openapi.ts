import type { z } from 'zod';
import type { RouteDefinition } from '../../src/routes.js';
import {
  buildComponents,
  COMPONENT_PREFIX,
  collectSchemas,
  type JsonSchema,
  toStandaloneJsonSchema,
} from './schema-catalog.js';

export interface OpenApiOptions {
  /** The package namespace (`import * as contracts`); every exported Zod schema becomes a component. */
  namespace: Readonly<Record<string, unknown>>;
  routes: readonly RouteDefinition<string>[];
  version: string;
  /** Title, description and servers; the local server's API by default. */
  info?: OpenApiInfo;
}

export interface OpenApiInfo {
  readonly title: string;
  readonly description: string;
  readonly servers: readonly { readonly url: string; readonly description: string }[];
}

const LOCAL_SERVER_INFO: OpenApiInfo = {
  title: 'Restaurant Operations Platform: local server API',
  description:
    'Generated from @rp/contracts by `pnpm contracts:docs`; do not edit by hand. Money is ' +
    'integer paise, rates are basis points, dates are YYYY-MM-DD and instants are ISO-8601 ' +
    'UTC. `x-capability` names the permission the server enforces (AUTH-010): a capability, ' +
    '`SESSION` (any signed-in person), `DEVICE` (a paired device, nobody signed in) or ' +
    '`PUBLIC`; ' +
    '`x-requirements` lists the BRD requirement IDs. Components cover every exported contract ' +
    'schema, including those not yet used by a route. A `<Name>Input` component describes ' +
    'what a client may send when it differs from the parsed form (for example omitted ' +
    'defaults).',
  servers: [
    { url: '/', description: "The restaurant's local server (address set at installation)" },
  ],
};

const PATH_PARAMETER = /:([A-Za-z][A-Za-z0-9_]*)/g;

/**
 * Builds an OpenAPI 3.1 document from a route registry (INT-002): the local server's API unless
 * `info` names another (the Control Plane's).
 */
export function buildOpenApi({
  namespace,
  routes,
  version,
  info = LOCAL_SERVER_INFO,
}: OpenApiOptions): JsonSchema {
  const named = collectSchemas(namespace);
  const nameOf = new Map([...named].map(([name, schema]) => [schema, name]));
  const components = buildComponents(named);

  const reference = (route: RouteDefinition<string>, schema: z.ZodType, io: 'input' | 'output') => {
    const name = nameOf.get(schema);
    if (name === undefined) {
      throw new Error(
        `Route ${route.operationId} uses a schema that is not exported from @rp/contracts; ` +
          'export it so it has a stable name in the document.',
      );
    }
    return { $ref: COMPONENT_PREFIX + (io === 'input' ? components.inputName(name) : name) };
  };

  const operationIds = new Set<string>();
  const paths: Record<string, Record<string, unknown>> = {};
  const sorted = [...routes].sort((a, b) =>
    a.path === b.path ? (a.method < b.method ? -1 : 1) : a.path < b.path ? -1 : 1,
  );
  for (const route of sorted) {
    if (operationIds.has(route.operationId)) {
      throw new Error(`Duplicate operationId ${route.operationId}`);
    }
    operationIds.add(route.operationId);
    const path = route.path.replace(PATH_PARAMETER, '{$1}');
    const method = route.method.toLowerCase();
    const item = (paths[path] ??= {});
    if (item[method] !== undefined)
      throw new Error(`Duplicate route ${route.method} ${route.path}`);

    const inPath = [...route.path.matchAll(PATH_PARAMETER)].map((match) => match[1]).sort();
    const declared = Object.keys(route.request?.params?.shape ?? {}).sort();
    if (inPath.join() !== declared.join()) {
      throw new Error(`Route ${route.operationId}: path parameters and params schema differ`);
    }

    const parameters = [
      ...parametersOf(route.request?.params, 'path'),
      ...parametersOf(route.request?.query, 'query'),
    ];
    const body = route.request?.body;
    const responses: Record<string, unknown> = {};
    for (const status of Object.keys(route.responses).sort()) {
      const response = route.responses[Number(status)];
      if (response === undefined) continue;
      responses[status] = {
        description: response.description,
        ...(response.schema && {
          content: { 'application/json': { schema: reference(route, response.schema, 'output') } },
        }),
      };
    }

    item[method] = {
      operationId: route.operationId,
      summary: route.summary,
      ...(route.description !== undefined && { description: route.description }),
      tags: [...route.tags],
      ...(parameters.length > 0 && { parameters }),
      ...(body && {
        requestBody: {
          required: true,
          content: { 'application/json': { schema: reference(route, body, 'input') } },
        },
      }),
      responses,
      'x-capability': route.capability,
      'x-requirements': [...route.requirements],
    };
  }

  const tags = [...new Set(routes.flatMap((route) => route.tags))].sort().map((name) => ({ name }));
  return {
    openapi: '3.1.1',
    info: { title: info.title, version, description: info.description },
    servers: info.servers.map((server) => ({ ...server })),
    tags,
    paths,
    components: { schemas: components.schemas },
  };
}

function parametersOf(schema: z.ZodObject | undefined, location: 'path' | 'query') {
  if (schema === undefined) return [];
  return Object.keys(schema.shape)
    .sort()
    .map((name) => {
      const field = schema.shape[name] as z.ZodType;
      return {
        name,
        in: location,
        required: location === 'path' || !field.safeParse(undefined).success,
        schema: toStandaloneJsonSchema(field, 'input'),
      };
    });
}
