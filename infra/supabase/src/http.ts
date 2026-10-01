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
 * Wraps a handler: answers CORS preflights, refuses other methods, and turns an `HttpError` (or
 * anything unexpected, without its details) into an ApiError response.
 */
export function serveWith(method: 'GET' | 'POST', handler: Handler): Handler {
  return async (request, context) => {
    const cors = corsHeaders(request, context.allowedOrigins);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let response: Response;
    try {
      if (request.method !== method) {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', `Use ${method}.`, undefined, {
          allow: `${method}, OPTIONS`,
        });
      }
      response = await handler(request, context);
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
  };
}

/** Reads and checks a JSON body; a bad one is a 400 with the problems, never the input. */
export async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let input: unknown;
  try {
    input = await request.json();
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
