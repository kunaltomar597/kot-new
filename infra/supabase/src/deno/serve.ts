import postgres, { type TransactionSql } from 'npm:postgres@3.4.7';
import type { RelayDatabase, Tx } from '../db.js';
import type { Handler, PhotoStorage } from '../http.js';

/** The part of the Deno runtime the entries use (Supabase Edge Functions run Deno 2). */
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): unknown;
  serve(
    options: { port: number; hostname: string },
    handler: (request: Request) => Promise<Response>,
  ): unknown;
};

/**
 * Serves a relay function on Supabase. RELAY_DB_URL is the edge functions' own login
 * (`relay_edge`, through the transaction pooler; manual task 20), never the service role.
 * RELAY_ALLOWED_ORIGINS lists the QR site's origins, comma-separated. RELAY_JWT_SECRET is the
 * project's JWT secret, for local servers' Realtime tokens (optional); RELAY_REALTIME_API_KEY, the
 * project's publishable key, is needed only where Supabase does not give SUPABASE_ANON_KEY. RELAY_PORT is for running a
 * bundle under plain Deno (test/deno-smoke.test.ts); Supabase gives the port itself.
 */
/**
 * The menu-photo bucket in Supabase Storage, written with the service-role key that Supabase gives
 * every edge function (inside the relay only; local servers never hold it, SEC-005). Paths never
 * change for a photo, so the CDN may keep them for a year.
 */
function storage(url: string, key: string): PhotoStorage {
  const bucket = `${url}/storage/v1/object`;
  return {
    publicBase: `${bucket}/public/menu-photos`,
    async put(path, bytes, contentType) {
      const response = await fetch(`${bucket}/menu-photos/${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': contentType,
          'cache-control': 'public, max-age=31536000, immutable',
          'x-upsert': 'true',
        },
        body: bytes,
      });
      if (!response.ok) throw new Error(`Storage answered ${String(response.status)}`);
    },
    async remove(paths) {
      const response = await fetch(`${bucket}/menu-photos`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prefixes: paths }),
      });
      if (!response.ok) throw new Error(`Storage answered ${String(response.status)}`);
    },
  };
}

export function serve(handler: Handler): void {
  const url = Deno.env.get('RELAY_DB_URL');
  if (url === undefined || url === '') throw new Error('RELAY_DB_URL is not set');
  const allowedOrigins = (Deno.env.get('RELAY_ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
  // The transaction pooler cannot keep prepared statements between transactions.
  const sql = postgres(url, { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 10 });
  const wrap = (transaction: TransactionSql): Tx => ({
    query: async <Row extends object>(text: string, params: readonly unknown[] = []) =>
      (await transaction.unsafe(text, [...params])) as Row[],
    savepoint: (work) => transaction.savepoint((inner) => work(wrap(inner))),
  });
  const db: RelayDatabase = {
    transaction: (work) => sql.begin((transaction) => work(wrap(transaction))),
  };
  const realtimeJwtSecret = Deno.env.get('RELAY_JWT_SECRET');
  const realtimeApiKey =
    Deno.env.get('RELAY_REALTIME_API_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const photos =
    supabaseUrl === undefined || serviceKey === undefined
      ? undefined
      : storage(supabaseUrl.replace(/\/+$/, ''), serviceKey);
  const answer = (request: Request) =>
    handler(request, {
      db,
      now: () => new Date(),
      allowedOrigins,
      realtimeJwtSecret,
      realtimeApiKey,
      photos,
    });
  const port = Deno.env.get('RELAY_PORT');
  if (port === undefined) Deno.serve(answer);
  else Deno.serve({ port: Number(port), hostname: '127.0.0.1' }, answer);
}
