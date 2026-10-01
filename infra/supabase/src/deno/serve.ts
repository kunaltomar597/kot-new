import postgres from 'npm:postgres@3.4.7';
import type { RelayDatabase, Tx } from '../db.js';
import type { Handler } from '../http.js';

/** The part of the Deno runtime the entries use (Supabase Edge Functions run Deno 2). */
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): unknown;
  serve(options: { port: number }, handler: (request: Request) => Promise<Response>): unknown;
};

/**
 * Serves a relay function on Supabase. RELAY_DB_URL is the edge functions' own login
 * (`relay_edge`, through the transaction pooler; manual task 20), never the service role.
 * RELAY_ALLOWED_ORIGINS lists the QR site's origins, comma-separated. RELAY_PORT is for running a
 * bundle under plain Deno (test/deno-smoke.test.ts); Supabase gives the port itself.
 */
export function serve(handler: Handler): void {
  const url = Deno.env.get('RELAY_DB_URL');
  if (url === undefined || url === '') throw new Error('RELAY_DB_URL is not set');
  const allowedOrigins = (Deno.env.get('RELAY_ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
  // The transaction pooler cannot keep prepared statements between transactions.
  const sql = postgres(url, { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 10 });
  const db: RelayDatabase = {
    transaction: (work) =>
      sql.begin((transaction) => {
        const tx: Tx = {
          query: async <Row extends object>(text: string, params: readonly unknown[] = []) =>
            (await transaction.unsafe(text, [...params])) as Row[],
        };
        return work(tx);
      }),
  };
  const answer = (request: Request) =>
    handler(request, { db, now: () => new Date(), allowedOrigins });
  const port = Deno.env.get('RELAY_PORT');
  if (port === undefined) Deno.serve(answer);
  else Deno.serve({ port: Number(port) }, answer);
}
