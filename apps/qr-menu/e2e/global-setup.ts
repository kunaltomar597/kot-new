import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELAY_MIGRATIONS_DIR, startRelay, SUPABASE_PRELUDE } from '@rp/relay/testing';
import { startTestDatabase } from '@rp/test-postgres';
import { bigMenuDocument, menuDocument } from './fixture.js';
import { STATE_FILE } from './state.js';

const SITE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

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

/**
 * A QR relay in a throwaway PostgreSQL (or TEST_DATABASE_URL), set up as a restaurant's local
 * server would: presence with the QR settings, two tables with codes, and the menu, all through
 * the relay's `server` function. Then the built site, pointed at it.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const cluster = await startTestDatabase({
    migrationsDir: RELAY_MIGRATIONS_DIR,
    prefix: 'qrsite',
    preludeFiles: [SUPABASE_PRELUDE],
  });
  const relay = await startRelay({ adminUrl: cluster.adminUrl, runId: cluster.runId });
  const { credential } = await relay.provision('Spice Route');
  const asServer = async (method: string, path: string, body: unknown) => {
    const response = await fetch(`${relay.baseUrl}/server/${path}`, {
      method,
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(`${path}: ${String(response.status)} ${await response.text()}`);
  };
  const tokens: Record<string, string> = {};
  const tableIds: Record<string, string> = {};
  for (const label of ['T1', 'T2']) {
    tokens[label] = randomBytes(16).toString('base64url');
    tableIds[label] = randomUUID();
  }
  await asServer('POST', 'presence', {
    serverVersion: '1.0.0',
    settings: {
      submissionsPerWindow: 50,
      rateLimitWindowMinutes: 10,
      pickupTimeoutSeconds: 60,
      presenceIntervalSeconds: 30,
      readOnlyAfterSeconds: 120,
    },
  });
  await asServer('PUT', 'tables', {
    tables: Object.entries(tokens).map(([label, token]) => ({
      tableId: tableIds[label],
      label,
      tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
      active: true,
    })),
  });
  await asServer('PUT', 'menu', { version: 1, document: menuDocument() });

  // A second restaurant with a large menu, for the speed budget (QR-012).
  const big = await relay.provision('Grand Thali House');
  const bigToken = randomBytes(16).toString('base64url');
  const asBig = async (method: string, path: string, body: unknown) => {
    const response = await fetch(`${relay.baseUrl}/server/${path}`, {
      method,
      headers: { authorization: `Bearer ${big.credential}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(`${path}: ${String(response.status)} ${await response.text()}`);
  };
  await asBig('POST', 'presence', {
    serverVersion: '1.0.0',
    settings: {
      submissionsPerWindow: 5,
      rateLimitWindowMinutes: 10,
      pickupTimeoutSeconds: 60,
      presenceIntervalSeconds: 30,
      readOnlyAfterSeconds: 120,
    },
  });
  await asBig('PUT', 'tables', {
    tables: [
      {
        tableId: randomUUID(),
        label: 'G1',
        tokenHash: createHash('sha256').update(bigToken, 'utf8').digest('hex'),
        active: true,
      },
    ],
  });
  await asBig('PUT', 'menu', { version: 1, document: bigMenuDocument() });
  tokens.BIG = bigToken;

  const port = await freePort();
  const site = `http://127.0.0.1:${String(port)}`;
  const next: ChildProcess = spawn(
    process.execPath,
    [
      join(SITE_DIR, 'node_modules', 'next', 'dist', 'bin', 'next'),
      'start',
      '--port',
      String(port),
      '--hostname',
      '127.0.0.1',
    ],
    {
      cwd: SITE_DIR,
      env: { ...process.env, RELAY_URL: relay.baseUrl, NEXT_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`The site did not start: ${output}`));
    }, 60_000);
    const listen = (chunk: Buffer) => {
      output += chunk.toString();
      if (/Ready|started server|Local:/i.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    };
    next.stdout?.on('data', listen);
    next.stderr?.on('data', listen);
    next.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`The site exited with ${String(code)}: ${output}`));
    });
  });

  writeFileSync(
    STATE_FILE,
    JSON.stringify({
      site,
      relayUrl: relay.baseUrl,
      relayDatabaseUrl: relay.databaseUrl,
      credential,
      tokens,
      tableIds,
    }),
  );
  return async () => {
    next.kill();
    await relay.stop();
    await cluster.stop();
    rmSync(STATE_FILE, { force: true });
  };
}
