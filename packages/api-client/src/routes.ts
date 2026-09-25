import { type RouteDefinition, ROUTES } from '@rp/contracts';
import type { z } from 'zod';

/**
 * Request and response types of every REST route, derived from the contract route registry
 * (INT-002): a route added to `@rp/contracts` is callable here, fully typed, with no generated code.
 */
type Route = (typeof ROUTES)[number];

/** Every operation, e.g. `pinLogin`. */
export type OperationId = Route['operationId'];

type RouteOf<Op extends OperationId> = Extract<Route, { readonly operationId: Op }>;
type RequestOf<Op extends OperationId> =
  RouteOf<Op> extends { readonly request: infer Request } ? Request : object;

type ParamsInput<Op extends OperationId> =
  RequestOf<Op> extends { readonly params: infer Params extends z.ZodType }
    ? { readonly params: z.input<Params> }
    : { readonly params?: never };
type QueryInput<Op extends OperationId> =
  RequestOf<Op> extends { readonly query: infer Query extends z.ZodType }
    ? { readonly query?: z.input<Query> }
    : { readonly query?: never };
type BodyInput<Op extends OperationId> =
  RequestOf<Op> extends { readonly body: infer Body extends z.ZodType }
    ? { readonly body: z.input<Body> }
    : { readonly body?: never };

/** Per-call options. */
export interface CallOptions {
  /** A manager's single-use approval for an OVERRIDE action (AUTH-011). */
  readonly overrideToken?: string;
  readonly signal?: AbortSignal;
  /** Default: the client's timeout (10 s). */
  readonly timeoutMs?: number;
  /** Default: a new id per call. */
  readonly correlationId?: string;
}

export type RequestInput<Op extends OperationId> = ParamsInput<Op> &
  QueryInput<Op> &
  BodyInput<Op> &
  CallOptions;

/** The input may be left out when the route has no path parameters and no body. */
export type RequestArgs<Op extends OperationId> =
  RequestOf<Op> extends { readonly params: unknown } | { readonly body: unknown }
    ? [input: RequestInput<Op>]
    : [input?: RequestInput<Op>];

type SuccessStatus = 200 | 201 | 202 | 204;
type Responses<Op extends OperationId> = RouteOf<Op>['responses'];

/** The parsed body of the route's success response (`undefined` for 204). */
export type ResponseOf<Op extends OperationId> = {
  [Status in keyof Responses<Op>]: Status extends SuccessStatus
    ? Responses<Op>[Status] extends { readonly schema: infer Schema extends z.ZodType }
      ? z.output<Schema>
      : undefined
    : never;
}[keyof Responses<Op>];

/** One method per operation: `client.api.pinLogin({ body })`. */
export type TypedApi = {
  readonly [Op in OperationId]: (...args: RequestArgs<Op>) => Promise<ResponseOf<Op>>;
};

/** Who must be signed in for a route: nobody, a paired device, or a person on that device. */
export type RouteAccess = 'public' | 'device' | 'session';

const BY_ID = new Map<string, RouteDefinition>(ROUTES.map((route) => [route.operationId, route]));

export function routeFor(operationId: OperationId): RouteDefinition {
  const route = BY_ID.get(operationId);
  if (route === undefined) throw new Error(`Unknown operation ${operationId}`);
  return route;
}

export function accessOf(route: RouteDefinition): RouteAccess {
  if (route.capability === 'PUBLIC') return 'public';
  if (route.capability === 'DEVICE') return 'device';
  return 'session';
}

export const OPERATION_IDS: readonly OperationId[] = ROUTES.map((route) => route.operationId);
