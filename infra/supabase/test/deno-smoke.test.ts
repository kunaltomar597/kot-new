import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ApiError,
  BROWSER_ID_HEADER,
  QrMenuResponse,
  QrOrderView,
  QrPickupResponse,
  QrSubmitOrderResponse,
  TABLE_TOKEN_HEADER,
} from '@rp/contracts/relay';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DINER_BODY_MAX_BYTES } from '../src/http.js';
import { IDS, qrMenuDocument } from './helpers/qr-menu.js';
import {
  letExpire,
  openRelayDb,
  publishMenu,
  type RelayDb,
  seedTenant,
  type SeededTenant,
} from './helpers/relay-db.js';
import { RELAY_DIR } from './setup/global-setup.js';

/**
 * The bundled functions as Supabase runs them: under Deno, on postgres.js, logged in as the edge
 * functions' own role (P5-02a, ADR-0015). Runs where Deno is installed (`deno` on PATH or
 * DENO_BIN); skipped otherwise.
 */

const DENO = process.env.DENO_BIN ?? 'deno';
const hasDeno = spawnSync(DENO, ['--version'], { encoding: 'utf8' }).status === 0;
const SITE = 'https://menu.example.in';

let db: RelayDb;
let tenant: SeededTenant;
let outDir: string;
const servers: ChildProcess[] = [];
const ports: Record<string, number> = {};
/** What the functions wrote to stderr, shown when a check fails. */
const denoLog: string[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
  });
}

/** Starts one bundled function under Deno and waits until it listens. */
async function start(name: string, databaseUrl: string): Promise<number> {
  const port = await freePort();
  const child = spawn(
    DENO,
    [
      'run',
      '--allow-net',
      '--allow-env',
      `--allow-read=${outDir}`,
      '--no-prompt',
      join(outDir, name, 'index.js'),
    ],
    {
      env: {
        ...process.env,
        RELAY_DB_URL: databaseUrl,
        RELAY_ALLOWED_ORIGINS: SITE,
        RELAY_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  servers.push(child);
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${name} did not start: ${output}`));
    }, 90_000);
    const listen = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('Listening on')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', listen);
    child.stderr.on('data', listen);
    child.stderr.on('data', (chunk: Buffer) => {
      denoLog.push(chunk.toString());
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${name} exited with ${String(code)}: ${output}`));
    });
  });
  return port;
}

const call = (name: string, init: RequestInit & { query?: string; path?: string } = {}) =>
  fetch(`http://127.0.0.1:${String(ports[name])}/${init.path ?? ''}${init.query ?? ''}`, {
    ...init,
    headers: {
      [TABLE_TOKEN_HEADER]: tenant.tables[0].token,
      [BROWSER_ID_HEADER]: 'browser-deno-smoke',
      'content-type': 'application/json',
      origin: SITE,
      ...(init.headers as Record<string, string> | undefined),
    },
  });

describe.runIf(hasDeno)('[QR-006] the bundled functions under Deno', () => {
  beforeAll(async () => {
    db = await openRelayDb();
    tenant = await seedTenant(db, 'Deno Diner');
    await publishMenu(db, tenant.id, 2, qrMenuDocument());
    outDir = mkdtempSync(join(tmpdir(), 'rp-relay-functions-'));
    const bundled = spawnSync(
      process.execPath,
      [join(RELAY_DIR, 'scripts', 'bundle-functions.mjs'), outDir],
      {
        encoding: 'utf8',
      },
    );
    expect(bundled.status, bundled.stderr).toBe(0);
    // The functions' login, as manual task 20 sets it up, with a password made for this run.
    const password = randomBytes(18).toString('hex');
    await db.admin.query(`ALTER ROLE relay_edge WITH LOGIN PASSWORD '${password}'`);
    const url = new URL(db.url);
    url.username = 'relay_edge';
    url.password = password;
    for (const name of ['qr-menu', 'submit-order', 'order-status', 'server']) {
      ports[name] = await start(name, url.toString());
    }
  }, 180_000);

  afterAll(async () => {
    for (const child of servers) child.kill();
    await db.admin.query('ALTER ROLE relay_edge WITH NOLOGIN PASSWORD NULL');
    rmSync(outDir, { recursive: true, force: true });
    await db.close();
  });

  it('serves the menu, takes an order once and reports it', async () => {
    const menu = await call('qr-menu');
    expect(menu.status, await menu.clone().text()).toBe(200);
    expect(menu.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(QrMenuResponse.parse(await menu.json())).toMatchObject({ version: 2, readOnly: false });

    const body = JSON.stringify({
      idempotencyKey: randomUUID(),
      lines: [{ clientLineId: randomUUID(), itemId: IDS.dal, quantity: 1, modifiers: [] }],
      customerName: 'Ravi',
    });
    const submit = async () => {
      const response = await call('submit-order', { method: 'POST', body });
      const text = await response.text();
      expect(response.status, `${text}\n${denoLog.join('')}`).toBe(200);
      return QrSubmitOrderResponse.parse(JSON.parse(text));
    };
    const first = await submit();
    const again = await submit();
    if (first.status !== 'ACCEPTED' || again.status !== 'ACCEPTED') throw new Error('not accepted');
    expect(again).toMatchObject({ replayed: true, order: { id: first.order.id } });

    const status = await call('order-status', { query: `?id=${first.order.id}` });
    expect(QrOrderView.parse(await status.json())).toMatchObject({
      id: first.order.id,
      status: 'SUBMITTED',
      customerName: 'Ravi',
    });
  });

  it('[QR-009] lets the local server publish, keep its tables, pick up and report', async () => {
    const asServer = async (path: string, method: string, body?: unknown) => {
      const response = await call('server', {
        path: `server/${path}`,
        method,
        headers: { authorization: `Bearer ${tenant.credential}` },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: await response.json(),
        log: denoLog.join(''),
      };
    };
    const settings = {
      submissionsPerWindow: 5,
      rateLimitWindowMinutes: 10,
      pickupTimeoutSeconds: 60,
      presenceIntervalSeconds: 30,
      readOnlyAfterSeconds: 120,
    };
    const presence = await asServer('presence', 'POST', { serverVersion: '1.0.0', settings });
    expect(presence.status, JSON.stringify(presence)).toBe(200);
    const menu = await asServer('menu', 'PUT', { version: 3, document: qrMenuDocument() });
    expect(menu.body).toEqual({ version: 3, replayed: false });
    const tables = await asServer('tables', 'PUT', {
      tables: tenant.tables.map((table) => ({
        tableId: table.id,
        label: table.label,
        tokenHash: createHash('sha256').update(table.token).digest('hex'),
        active: true,
      })),
    });
    expect(tables.body, JSON.stringify(tables)).toEqual({ withCode: 2, deactivated: 0 });
    const pickup = QrPickupResponse.parse((await asServer('orders', 'GET')).body);
    const waiting = pickup.orders.at(-1);
    if (waiting === undefined) throw new Error('nothing to pick up');
    const received = await asServer(`orders/${waiting.id}/status`, 'POST', { status: 'RECEIVED' });
    expect(received.body, JSON.stringify(received)).toEqual({ id: waiting.id, status: 'RECEIVED' });

    // Too late to receive: the savepoint keeps the expiry and the answer says so.
    const late = pickup.orders[0];
    if (late === undefined || late.id === waiting.id) throw new Error('need two orders');
    await letExpire(db, late.id);
    const expired = await asServer(`orders/${late.id}/status`, 'POST', { status: 'RECEIVED' });
    expect(expired.status, JSON.stringify(expired)).toBe(410);
    const { rows } = await db.admin.query<{ status: string }>(
      'SELECT status FROM relay.qr_orders WHERE id = $1',
      [late.id],
    );
    expect(rows[0]?.status).toBe('EXPIRED');
  });

  it('[RELAY-D3] refuses a large body, announced or sent in chunks, and answers no browser from the PCs’ function', async () => {
    const tooLarge = 'x'.repeat(DINER_BODY_MAX_BYTES + 1);
    const announced = await call('submit-order', { method: 'POST', body: tooLarge });
    expect(announced.status, denoLog.join('')).toBe(413);
    expect(((await announced.json()) as ApiError).code).toBe('PAYLOAD_TOO_LARGE');
    // Chunked, without a length: refused once the cap is passed, before the rest is sent.
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent >= 8 * 1024 * 1024) controller.close();
          else {
            sent += chunk.length;
            controller.enqueue(chunk);
          }
        },
      },
      { highWaterMark: 0 },
    );
    // Deno may close the socket while the client is still writing; on a busy machine the client
    // then sees EPIPE instead of reading the 413. Both are a refusal before the rest is sent.
    const chunked = await call('submit-order', {
      method: 'POST',
      body,
      duplex: 'half',
    }).catch((error: unknown) => {
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (code === 'EPIPE' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return null;
      throw error;
    });
    if (chunked !== null) expect(chunked.status).toBe(413);
    expect(sent).toBeLessThan(8 * 1024 * 1024);

    const server = await call('server', {
      path: 'server/orders',
      headers: { authorization: `Bearer ${tenant.credential}` },
    });
    expect(server.status).toBe(200);
    expect(server.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses an unknown table code', async () => {
    const response = await call('qr-menu', {
      headers: { [TABLE_TOKEN_HEADER]: randomBytes(16).toString('base64url') },
    });
    expect(response.status).toBe(404);
  });
});
