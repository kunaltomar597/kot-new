import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BROWSER_ID_HEADER,
  QrMenuResponse,
  QrOrderView,
  QrSubmitOrderResponse,
  TABLE_TOKEN_HEADER,
} from '@rp/contracts/relay';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDS, qrMenuDocument } from './helpers/qr-menu.js';
import {
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

const call = (name: string, init: RequestInit & { query?: string } = {}) =>
  fetch(`http://127.0.0.1:${String(ports[name])}/${init.query ?? ''}`, {
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
    for (const name of ['qr-menu', 'submit-order', 'order-status']) {
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

  it('refuses an unknown table code', async () => {
    const response = await call('qr-menu', {
      headers: { [TABLE_TOKEN_HEADER]: randomBytes(16).toString('base64url') },
    });
    expect(response.status).toBe(404);
  });
});
