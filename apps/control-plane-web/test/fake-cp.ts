import {
  CONTROL_PLANE_ROUTES,
  type ControlPlaneOperationId,
  VENDOR_CAPABILITIES,
  type VendorCapability,
  type VendorRole,
  vendorMay,
} from '@rp/contracts/control-plane';

export interface FakeCall {
  readonly operationId: ControlPlaneOperationId;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
}

type Handler = (call: FakeCall) => unknown;

/** A refusal a handler throws, answered as the Control Plane's `ApiError`. */
export class FakeRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const ROUTES = CONTROL_PLANE_ROUTES.map((route) => ({
  route,
  names: [...route.path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1] ?? ''),
  pattern: new RegExp(`^${route.path.replace(/:[A-Za-z]+/g, '([^/]+)')}$`),
}));

const isCapability = (value: string): value is VendorCapability =>
  (VENDOR_CAPABILITIES as readonly string[]).includes(value);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * The Control Plane as the web app's tests see it: routes matched from the contract registry, the
 * session's role checked against the same capability matrix as the real service (deny by default),
 * and a handler per operation. Every call is recorded.
 */
export class FakeControlPlane {
  readonly calls: FakeCall[] = [];
  /** The role behind the bearer token; undefined: no session. */
  role: VendorRole | undefined;
  private readonly handlers = new Map<string, Handler>();

  on(operationId: ControlPlaneOperationId, handler: Handler): this {
    this.handlers.set(operationId, handler);
    return this;
  }

  callsOf(operationId: ControlPlaneOperationId): FakeCall[] {
    return this.calls.filter((call) => call.operationId === operationId);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    await Promise.resolve();
    const url = new URL(input instanceof Request ? input.url : input.toString(), 'https://cp.test');
    const method = init?.method ?? 'GET';
    const found = ROUTES.find(
      ({ route, pattern }) => route.method === method && pattern.test(url.pathname),
    );
    if (found === undefined) return json(404, { code: 'NOT_FOUND', message: 'No such route' });
    const { route, names, pattern } = found;
    const values = pattern.exec(url.pathname)?.slice(1) ?? [];
    const params = Object.fromEntries(
      names.map((name, index) => [name, decodeURIComponent(values[index] ?? '')]),
    );
    const call: FakeCall = {
      operationId: route.operationId,
      params,
      query: Object.fromEntries(url.searchParams),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    this.calls.push(call);
    const headers = new Headers(init?.headers);
    if (route.capability !== 'PUBLIC') {
      if (this.role === undefined || headers.get('authorization') === null) {
        return json(401, { code: 'VENDOR_UNAUTHENTICATED', message: 'Sign in again.' });
      }
      if (isCapability(route.capability) && !vendorMay(this.role, route.capability)) {
        return json(403, { code: 'FORBIDDEN', message: 'Not allowed.' });
      }
    }
    const handler = this.handlers.get(route.operationId);
    if (handler === undefined) {
      return json(501, { code: 'NO_HANDLER', message: `No test handler for ${route.operationId}` });
    }
    try {
      const result = await handler(call);
      const statuses = Object.keys(route.responses).map(Number);
      const status = statuses.find((code) => code >= 200 && code < 300) ?? 200;
      return status === 204 ? new Response(null, { status }) : json(status, result);
    } catch (error) {
      if (error instanceof FakeRefusal) {
        return json(error.status, { code: error.code, message: error.message });
      }
      throw error;
    }
  };
}
