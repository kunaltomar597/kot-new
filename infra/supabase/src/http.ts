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

/** Answers a request: CORS, then `work`, with failures turned into ApiError responses. */
async function respond(
  request: Request,
  context: FunctionContext,
  work: () => Promise<Response>,
): Promise<Response> {
  const cors = corsHeaders(request, context.allowedOrigins);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
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
  for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
  return response;
}

/** A function that takes one method: answers CORS preflights and refuses other methods. */
export function serveWith(method: 'GET' | 'POST', handler: Handler): Handler {
  return (request, context) =>
    respond(request, context, () => {
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

/** A function with several routes under its name, e.g. `server/presence`. */
export function serveRoutes(routes: readonly Route[]): Handler {
  return (request, context) =>
    respond(request, context, () => {
      const path = new URL(request.url).pathname;
      const matching = routes.filter((route) => route.path.test(path));
      if (matching.length === 0) throw new HttpError(404, 'NOT_FOUND', 'No such relay function.');
      const route = matching.find((candidate) => candidate.method === request.method);
      const match = route?.path.exec(path) ?? undefined;
      if (route === undefined || match === undefined) {
        const allow = [...new Set(matching.map((candidate) => candidate.method))].join(', ');
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', `Use ${allow}.`, undefined, { allow });
      }
      return route.handler(request, context, match);
    });
}

/** The largest body a function reads: a menu of 1,000 dishes is well under 2 MB. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Reads a binary body of at most `maxBytes` (a photo); anything bigger is a 413. */
export async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The file is too large.');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > maxBytes)
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The file is too large.');
  if (bytes.length === 0) throw new HttpError(400, 'VALIDATION_FAILED', 'The file is empty.');
  return bytes;
}

/** Reads and checks a JSON body; a bad one is a 400 with the problems, never the input. */
export async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The body is too large.');
  }
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
