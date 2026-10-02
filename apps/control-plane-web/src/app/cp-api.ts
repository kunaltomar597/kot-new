import {
  ApiError,
  CONTROL_PLANE_ROUTES,
  type ControlPlaneAccess,
  type ControlPlaneOperationId,
} from '@rp/contracts/control-plane';
import type { RouteDefinition } from '@rp/contracts';
import type { z } from 'zod';

/**
 * A typed client for the Vendor Control Plane's routes (INT-002), derived from the contract
 * registry: `api.getVendorTenant({ params: { id } })`. Responses are checked against their schema;
 * a refusal becomes a `CpApiError` with the server's code and plain-language message.
 */
type Route = (typeof CONTROL_PLANE_ROUTES)[number];
type RouteOf<Op extends ControlPlaneOperationId> = Extract<Route, { readonly operationId: Op }>;
type RequestOf<Op extends ControlPlaneOperationId> =
  RouteOf<Op> extends { readonly request: infer Request } ? Request : object;

type ParamsInput<Op extends ControlPlaneOperationId> =
  RequestOf<Op> extends { readonly params: infer Params extends z.ZodType }
    ? { readonly params: z.input<Params> }
    : { readonly params?: never };
type QueryInput<Op extends ControlPlaneOperationId> =
  RequestOf<Op> extends { readonly query: infer Query extends z.ZodType }
    ? { readonly query?: z.input<Query> }
    : { readonly query?: never };
type BodyInput<Op extends ControlPlaneOperationId> =
  RequestOf<Op> extends { readonly body: infer Body extends z.ZodType }
    ? { readonly body: z.input<Body> }
    : { readonly body?: never };

export type CpRequest<Op extends ControlPlaneOperationId> = ParamsInput<Op> &
  QueryInput<Op> &
  BodyInput<Op> & { readonly signal?: AbortSignal };

type CpArgs<Op extends ControlPlaneOperationId> =
  RequestOf<Op> extends { readonly params: unknown } | { readonly body: unknown }
    ? [input: CpRequest<Op>]
    : [input?: CpRequest<Op>];

type Responses<Op extends ControlPlaneOperationId> = RouteOf<Op>['responses'];
export type CpResponse<Op extends ControlPlaneOperationId> = {
  [Status in keyof Responses<Op>]: Status extends 200 | 201 | 204
    ? Responses<Op>[Status] extends { readonly schema: infer Schema extends z.ZodType }
      ? z.output<Schema>
      : undefined
    : never;
}[keyof Responses<Op>];

/** One method per vendor operation. */
export type CpApi = {
  readonly [Op in ControlPlaneOperationId]: (...args: CpArgs<Op>) => Promise<CpResponse<Op>>;
};

/** The Control Plane refused: its status, code and message (shown as they are, NFR-U04). */
export class CpApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CpApiError';
  }
}

/** The Control Plane could not be reached, or did not answer in time. */
export class CpUnavailableError extends Error {
  constructor(readonly reason: 'network' | 'timeout') {
    super(reason === 'timeout' ? 'The Control Plane did not answer in time' : 'No connection');
    this.name = 'CpUnavailableError';
  }
}

export interface CpClientOptions {
  /** Empty for the page's own origin (the Control Plane serves this app). */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  /** The bearer token of the session, if any. */
  readonly token: () => string | undefined;
  /** A signed-in call was refused with 401: the session is over. */
  readonly onSessionOver?: () => void;
  readonly timeoutMs?: number;
}

const BY_ID = new Map<string, RouteDefinition<ControlPlaneAccess>>(
  CONTROL_PLANE_ROUTES.map((route) => [route.operationId, route]),
);

function pathOf(route: RouteDefinition<ControlPlaneAccess>, params: unknown): string {
  const values = (params ?? {}) as Record<string, unknown>;
  return route.path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = values[name];
    if (typeof value !== 'string' || value === '')
      throw new Error(`Missing path parameter ${name}`);
    return encodeURIComponent(value);
  });
}

function queryOf(query: unknown): string {
  if (query === undefined || query === null) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

function successSchema(route: RouteDefinition<ControlPlaneAccess>, status: number) {
  return route.responses[status]?.schema;
}

/** Creates the typed client. */
export function createCpApi(options: CpClientOptions): CpApi {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function call(operationId: string, input: Record<string, unknown> = {}): Promise<unknown> {
    const route = BY_ID.get(operationId);
    if (route === undefined) throw new Error(`Unknown operation ${operationId}`);
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = options.token();
    if (route.capability !== 'PUBLIC' && token !== undefined) {
      headers.authorization = `Bearer ${token}`;
    }
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    if (body !== undefined) headers['content-type'] = 'application/json';
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal =
      input.signal instanceof AbortSignal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await doFetch(
        `${options.baseUrl}${pathOf(route, input.params)}${queryOf(input.query)}`,
        { method: route.method, headers, body, signal },
      );
    } catch (error) {
      if (input.signal instanceof AbortSignal && input.signal.aborted) throw error;
      throw new CpUnavailableError(timeout.aborted ? 'timeout' : 'network');
    }
    if (response.status === 204) return undefined;
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const parsed = ApiError.safeParse(payload);
      if (response.status === 401 && route.capability !== 'PUBLIC') options.onSessionOver?.();
      throw parsed.success
        ? new CpApiError(response.status, parsed.data.code, parsed.data.message)
        : new CpApiError(response.status, 'UNEXPECTED', response.statusText || 'Request failed');
    }
    const schema = successSchema(route, response.status);
    return schema === undefined ? payload : schema.parse(payload);
  }

  return new Proxy({} as CpApi, {
    get: (_target, name) =>
      typeof name === 'string' && BY_ID.has(name)
        ? (input?: Record<string, unknown>) => call(name, input)
        : undefined,
  });
}
