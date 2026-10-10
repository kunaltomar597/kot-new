import type { ApiError } from '@rp/contracts/relay';
import type { z } from 'zod';
import { BROWSER_ID_HEADER, TABLE_TOKEN_HEADER } from '@rp/contracts/relay';
import type { RelayDatabase } from './db.js';

/** What every relay function gets besides the request. */
export interface FunctionContext {
  readonly db: RelayDatabase;
  readonly now: () => Date;
  /** Origins of the QR site allowed to call from a browser (CORS); `*` for any. */
  readonly allowedOrigins: readonly string[];
  /**
   * The secret Supabase verifies Realtime tokens with (the project's JWT secret, set as a function
   * secret); without it local servers poll instead (P5-02b).
   */
  readonly realtimeJwtSecret?: string | undefined;
  /** The project's public API key, which Realtime's socket asks for (P5-03d). */
  readonly realtimeApiKey?: string | undefined;
  /** Where menu photos are kept and served from (P5-03c); none means photos are not taken. */
  readonly photos?: PhotoStorage | undefined;
}

/** The menu-photo bucket (Supabase Storage on the relay; memory in tests). */
export interface PhotoStorage {
  /** Where the site loads `path` from: `<publicBase>/<path>`. */
  readonly publicBase: string;
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  remove(paths: readonly string[]): Promise<void>;
}

export type Handler = (request: Request, context: FunctionContext) => Promise<Response>;

/** A refusal with its status and ApiError code; thrown by handlers and answered by `serve`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Answers depend on the live restaurant (presence, order status): never cached.
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

/** The SQLSTATE of a database error from either driver. */
export function sqlStateOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Headers on every answer, preflights included (P8-03c1): JSON is never run as a page, framed or
 * sniffed into another type, and a link out of it sends no address (which holds the table's code).
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  // base-uri, form-action and frame-ancestors do not fall back to default-src: each is set.
  'content-security-policy':
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

const ALLOWED_HEADERS = [
  'authorization',
  'apikey',
  'content-type',
  'x-client-info',
  TABLE_TOKEN_HEADER,
  BROWSER_ID_HEADER,
].join(', ');

function corsHeaders(request: Request, allowed: readonly string[]): Record<string, string> {
  const origin = request.headers.get('origin');
  if (origin === null) return {};
  if (!allowed.includes('*') && !allowed.includes(origin)) return { vary: 'Origin' };
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': ALLOWED_HEADERS,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

/**
 * Writes an unexpected failure to the function's log (Supabase keeps it): what failed and where,
 * never a database error's detail, which can hold the row's values.
 */
function logFailure(request: Request, error: unknown): void {
  const failure = error instanceof Error ? error : new Error(String(error));
  const code = (failure as { code?: unknown }).code;
  // eslint-disable-next-line no-console -- the function's log is how operators see failures.
  console.error(
    JSON.stringify({
      level: 'error',
      path: new URL(request.url).pathname,
      name: failure.name,
      code: typeof code === 'string' ? code : undefined,
      message: failure.message,
    }),
  );
}

/**
 * Answers a request: CORS for browsers (none for a function only PCs call, RELAY-I5), then
 * `work`, with failures turned into ApiError responses.
 */
async function respond(
  request: Request,
  context: FunctionContext,
  browsers: boolean,
  work: () => Promise<Response>,
): Promise<Response> {
  const cors = browsers ? corsHeaders(request, context.allowedOrigins) : {};
  if (browsers && request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...cors } });
  }
  let response: Response;
  try {
    response = await work();
  } catch (error) {
    if (!(error instanceof HttpError)) logFailure(request, error);
    const failure =
      error instanceof HttpError
        ? error
        : new HttpError(500, 'INTERNAL', 'Something went wrong. Please try again.');
    const body: ApiError = {
      code: failure.code,
      message: failure.message,
      ...(failure.details !== undefined && { details: failure.details }),
    };
    response = json(failure.status, body, failure.headers);
  }
  for (const [name, value] of Object.entries({ ...SECURITY_HEADERS, ...cors })) {
    response.headers.set(name, value);
  }
  return response;
}

/** A function that takes one method: answers CORS preflights and refuses other methods. */
export function serveWith(method: 'GET' | 'POST', handler: Handler): Handler {
  return (request, context) =>
    respond(request, context, true, () => {
      if (request.method !== method) {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', `Use ${method}.`, undefined, {
          allow: `${method}, OPTIONS`,
        });
      }
      return handler(request, context);
    });
}

export interface Route {
  readonly method: 'GET' | 'POST' | 'PUT';
  /** Matched against the end of the URL's path (Supabase keeps the function's name in it). */
  readonly path: RegExp;
  readonly handler: (
    request: Request,
    context: FunctionContext,
    match: RegExpExecArray,
  ) => Promise<Response>;
}

export interface RoutesOptions {
  /**
   * Whether browsers call the function: only then does it answer CORS preflights and send CORS
   * headers. The `server` function is for restaurant PCs, which are no browsers (RELAY-I5).
   */
  readonly browsers: boolean;
  /**
   * Checks the caller before the route's handler reads anything of the body (RELAY-D3): a call
   * without a well-formed credential is refused before its body is read.
   */
  readonly admit?: (request: Request) => void;
}

/** A function with several routes under its name, e.g. `server/presence`. */
export function serveRoutes(
  routes: readonly Route[],
  options: RoutesOptions = { browsers: true },
): Handler {
  return (request, context) =>
    respond(request, context, options.browsers, () => {
      const path = new URL(request.url).pathname;
      const matching = routes.filter((route) => route.path.test(path));
      if (matching.length === 0) throw new HttpError(404, 'NOT_FOUND', 'No such relay function.');
      const route = matching.find((candidate) => candidate.method === request.method);
      const match = route?.path.exec(path) ?? undefined;
      if (route === undefined || match === undefined) {
        const allow = [...new Set(matching.map((candidate) => candidate.method))].join(', ');
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', `Use ${allow}.`, undefined, { allow });
      }
      options.admit?.(request);
      return route.handler(request, context, match);
    });
}

/** The largest body the `server` function reads: a menu of 1,000 dishes is well under 2 MB. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * The largest body a diner's function reads (RELAY-D3). The largest order a diner could send, 100
 * lines with options, combos and long notes, is well under it (test/http.test.ts).
 */
export const DINER_BODY_MAX_BYTES = 512 * 1024;

const tooLarge = (what: string) => new HttpError(413, 'PAYLOAD_TOO_LARGE', `${what} is too large.`);

/**
 * Reads a body of at most `maxBytes` (RELAY-D3): one whose announced length is larger is refused
 * before anything is read, and one sent without a length (chunked) is refused as soon as more than
 * that has arrived, so no caller makes a function hold more.
 */
async function readCapped(request: Request, maxBytes: number, what: string): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw tooLarge(what);
  if (request.body === null) return new Uint8Array(0);
  const reader: ReadableStreamDefaultReader<Uint8Array> = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      // Stop the sender; what it sent so far is dropped with the reader.
      reader.cancel().catch(() => undefined);
      throw tooLarge(what);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Reads a binary body of at most `maxBytes` (a photo); anything bigger is a 413. */
export async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const bytes = await readCapped(request, maxBytes, 'The file');
  if (bytes.length === 0) throw new HttpError(400, 'VALIDATION_FAILED', 'The file is empty.');
  return bytes;
}

/**
 * Reads and checks a JSON body of at most `maxBytes`; a bad one is a 400 with the problems, never
 * the input.
 */
export async function readBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes = MAX_BODY_BYTES,
): Promise<T> {
  const text = new TextDecoder().decode(await readCapped(request, maxBytes, 'The body'));
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'VALIDATION_FAILED', 'The body must be JSON.');
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'The request does not match the contract.', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}
