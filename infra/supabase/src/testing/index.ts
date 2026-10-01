import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMigratedDatabase, type TestDatabase } from '@rp/test-postgres';
import pg from 'pg';
import type { RelayDatabase, Tx } from '../db.js';
import type { FunctionContext, Handler, PhotoStorage } from '../http.js';
import { orderStatus } from '../order-status.js';
import { qrMenu } from '../qr-menu.js';
import { server } from '../server.js';
import { serviceRequest } from '../service-request.js';
import { submitOrder } from '../submit-order.js';

/**
 * The QR relay for tests outside this package (`@rp/relay/testing`): its schema in a database of
 * the test cluster and its functions behind a local HTTP server, as the local server's sync agent
 * reaches them on Supabase (P5-03). Never part of a product build.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The relay's migrations, in the Supabase CLI's layout. */
export const RELAY_MIGRATIONS_DIR = join(root, 'migrations');
/** What a Supabase project already has: its API roles and the Realtime publication. */
export const SUPABASE_PRELUDE = join(root, 'test', 'setup', 'supabase-prelude.sql');

/** Every function, by the name Supabase serves it under (`/functions/v1/<name>`). */
export const FUNCTIONS: Readonly<Record<string, Handler>> = {
  'qr-menu': qrMenu,
  'submit-order': submitOrder,
  'order-status': orderStatus,
  'service-request': serviceRequest,
  server,
};

/**
 * The functions' database on node-postgres, as on Supabase: each transaction runs as the edge
 * functions' login (`relay_edge`), and, like postgres.js there, a statement that fails outside a
 * savepoint fails the whole transaction even when caught. The pool must connect as a superuser.
 */
export function pgRelayDatabase(pool: pg.Pool): RelayDatabase {
  return {
    async transaction(work) {
      const client = await pool.connect();
      let depth = 0;
      let savepoints = 0;
      let uncaught: Error | undefined;
      const tx: Tx = {
        async query<Row extends object>(text: string, params: readonly unknown[] = []) {
          try {
            return (await client.query<Row>(text, [...params])).rows;
          } catch (error) {
            if (depth === 0) uncaught ??= error instanceof Error ? error : new Error(String(error));
            throw error;
          }
        },
        async savepoint(inner) {
          savepoints += 1;
          const name = `sp_${String(savepoints)}`;
          await client.query(`SAVEPOINT ${name}`);
          depth += 1;
          try {
            const value = await inner(tx);
            await client.query(`RELEASE SAVEPOINT ${name}`);
            return value;
          } catch (error) {
            await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
            throw error;
          } finally {
            depth -= 1;
          }
        },
      };
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL SESSION AUTHORIZATION relay_edge');
        const result = await work(tx);
        if (uncaught !== undefined) throw uncaught;
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/** Serves `functions` over Node's HTTP server the way Supabase does: `/functions/v1/<name>/...`. */
export function nodeListener(
  functions: Readonly<Record<string, Handler>>,
  context: FunctionContext,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (incoming, outgoing) => {
    void (async () => {
      const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
      const name = /^\/functions\/v1\/([a-z-]+)(?:\/|$)/.exec(url.pathname)?.[1];
      const handler = name === undefined ? undefined : functions[name];
      if (handler === undefined) {
        outgoing.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (typeof value === 'string') headers.set(key, value);
        else if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      }
      const method = incoming.method ?? 'GET';
      const response = await handler(
        new Request(url, {
          method,
          headers,
          ...(method !== 'GET' && method !== 'HEAD' && { body: Buffer.concat(chunks) }),
        }),
        context,
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => {
      outgoing.destroy();
    });
  };
}

export interface ProvisionedTenant {
  readonly tenantId: string;
  /** The credential the Control Plane would hand the local server (VCP-002). */
  readonly credential: string;
}

export interface TestRelay {
  /** The functions' base URL, as `RP_RELAY_URL` takes it: `http://127.0.0.1:<port>/functions/v1`. */
  readonly baseUrl: string;
  /** The relay's database, as its superuser. */
  readonly admin: pg.Pool;
  readonly databaseUrl: string;
  /** Creates a restaurant with a credential, as the Control Plane's provisioning does. */
  provision(name: string): Promise<ProvisionedTenant>;
  /** Cuts the internet: every request is dropped until `restore()`. */
  cut(): void;
  restore(): void;
  /** Requests the functions answered (not the dropped ones), by path. */
  readonly requests: string[];
  /** The photo files in the relay's bucket, by path. */
  readonly photoFiles: ReadonlyMap<string, Uint8Array>;
  stop(): Promise<void>;
}

/**
 * Starts a relay for a test: a fresh database with the relay's schema in the cluster at
 * `adminUrl`, and its functions on a local port.
 */
export async function startRelay(options: {
  readonly adminUrl: string;
  readonly runId: string;
  readonly realtimeJwtSecret?: string;
}): Promise<TestRelay> {
  // The relay's roles are cluster-wide: test files that start a relay at the same time would race
  // to create them, so one at a time (a lock in the cluster's own database, held by this session).
  const lock = new pg.Client({ connectionString: options.adminUrl });
  await lock.connect();
  let database: TestDatabase;
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext('rp.test.relay-database'))");
    database = await createMigratedDatabase({
      adminUrl: options.adminUrl,
      runId: options.runId,
      prefix: 'relay',
      migrationsDir: RELAY_MIGRATIONS_DIR,
      preludeFiles: [SUPABASE_PRELUDE],
    });
  } finally {
    await lock.end();
  }
  const admin = new pg.Pool({ connectionString: database.url, max: 6 });
  // The port is known only once listening, so the photo store learns its address after.
  let origin = '';
  const files = new Map<string, Uint8Array>();
  const photos: PhotoStorage = {
    get publicBase() {
      return `${origin}/storage/v1/object/public/menu-photos`;
    },
    put(path, bytes) {
      files.set(path, bytes);
      return Promise.resolve();
    },
    remove(paths) {
      for (const path of paths) files.delete(path);
      return Promise.resolve();
    },
  };
  const context: FunctionContext = {
    db: pgRelayDatabase(admin),
    now: () => new Date(),
    allowedOrigins: ['*'],
    realtimeJwtSecret: options.realtimeJwtSecret,
    photos,
  };
  const listener = nodeListener(FUNCTIONS, context);
  const requests: string[] = [];
  let reachable = true;
  const PUBLIC = '/storage/v1/object/public/menu-photos/';
  const http: Server = createServer((incoming, outgoing) => {
    if (!reachable) {
      incoming.socket.destroy();
      return;
    }
    const url = incoming.url ?? '';
    // The bucket's public address, as the CDN serves it.
    if (url.startsWith(PUBLIC)) {
      const file = files.get(decodeURIComponent(url.slice(PUBLIC.length)));
      if (file === undefined) outgoing.writeHead(404).end();
      else outgoing.writeHead(200, { 'content-type': 'image/webp' }).end(file);
      return;
    }
    requests.push(`${incoming.method ?? 'GET'} ${url}`);
    listener(incoming, outgoing);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  origin = `http://127.0.0.1:${String(port)}`;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/functions/v1`,
    admin,
    databaseUrl: database.url,
    requests,
    photoFiles: files,
    async provision(name) {
      const tenantId = randomUUID();
      const credential = randomBytes(32).toString('base64url');
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE relay_provisioner');
        await client.query('SELECT relay.provision_tenant($1, $2)', [tenantId, name]);
        await client.query('SELECT relay.add_credential($1, $2, $3)', [
          tenantId,
          createHash('sha256').update(credential, 'utf8').digest(),
          'Test PC',
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return { tenantId, credential };
    },
    cut() {
      reachable = false;
    },
    restore() {
      reachable = true;
    },
    async stop() {
      http.closeAllConnections();
      await new Promise<void>((resolve) => {
        http.close(() => {
          resolve();
        });
      });
      await admin.end();
      await database.drop();
    },
  };
}
