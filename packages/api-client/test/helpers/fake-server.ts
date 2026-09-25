export interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface FakeResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

type Handler = (call: RecordedCall) => FakeResponse | Promise<FakeResponse>;

/** An in-memory stand-in for the local server's REST API, as seen through `fetch`. */
export class FakeServer {
  readonly calls: RecordedCall[] = [];
  private readonly handlers = new Map<string, Handler[]>();

  /** Answers `method path` with `handler`; several handlers answer successive calls in turn. */
  on(method: string, path: string, ...handlers: Handler[]): this {
    this.handlers.set(`${method} ${path}`, handlers);
    return this;
  }

  callsTo(method: string, path: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method && call.path === path);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const raw = init?.body;
    const call: RecordedCall = {
      method: init?.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers,
      body: typeof raw === 'string' ? (JSON.parse(raw) as unknown) : undefined,
    };
    this.calls.push(call);
    const queue = this.handlers.get(`${call.method} ${url.pathname}`);
    const handler = queue?.length === 1 ? queue[0] : queue?.shift();
    if (handler === undefined) {
      return new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'No such route' }), {
        status: 404,
      });
    }
    const answer = await handler(call);
    return new Response(
      answer.body === undefined
        ? null
        : typeof answer.body === 'string'
          ? answer.body
          : JSON.stringify(answer.body),
      {
        status: answer.status,
        headers: { 'content-type': 'application/json', ...answer.headers },
      },
    );
  };
}
