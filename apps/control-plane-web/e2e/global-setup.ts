import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneTemplateDatabase, startTestDatabase } from '@rp/test-postgres';
import { type E2eState, STATE_FILE } from './state.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTROL_PLANE = join(WEB, '..', 'control-plane');
const EMAIL = 'owner@vendor.example';

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

async function waitForHealth(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('The Control Plane exited while starting');
    try {
      if ((await fetch(`${baseUrl}/v1/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('The Control Plane did not become healthy in 30 s');
}

/**
 * The built Control Plane on a free port with a throwaway database (or TEST_DATABASE_URL), serving
 * the built web app (CP_WEB_DIR), and its first Super Admin created with the CLI.
 */
export default async function setup(): Promise<() => Promise<void>> {
  for (const built of [
    join(WEB, 'dist', 'index.html'),
    join(CONTROL_PLANE, 'dist', 'main.js'),
    join(CONTROL_PLANE, 'dist', 'cli.js'),
  ]) {
    if (!existsSync(built)) throw new Error(`${built} is missing: run pnpm build first`);
  }
  const cluster = await startTestDatabase({
    migrationsDir: join(CONTROL_PLANE, 'prisma', 'migrations'),
    prefix: 'cpweb',
  });
  const database = await cloneTemplateDatabase({
    adminUrl: cluster.adminUrl,
    templateDatabase: cluster.templateDatabase,
    runId: cluster.runId,
    prefix: 'cpweb',
  });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const env = {
    ...process.env,
    CP_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_URL: database.url,
    CP_SECRET_KEY: randomBytes(32).toString('base64'),
    CP_WEB_DIR: join(WEB, 'dist'),
    CP_BILLING_INTERVAL_MINUTES: '0',
    CP_ACTOR: 'cli:e2e',
    LOG_LEVEL: 'warn',
  };
  const child = spawn('node', [join(CONTROL_PLANE, 'dist', 'main.js')], {
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitForHealth(baseUrl, child);

  // The first Super Admin, exactly as docs/runbooks/control-plane.md says.
  const printed = execFileSync(
    'node',
    [
      join(CONTROL_PLANE, 'dist', 'cli.js'),
      'vendor-user:create',
      '--email',
      EMAIL,
      '--name',
      'Asha Rao',
      '--role',
      'SUPER_ADMIN',
    ],
    { env, encoding: 'utf8' },
  );
  const setupToken = /Setup token[^:]*: ([A-Za-z0-9_-]{43})/.exec(printed)?.[1];
  if (setupToken === undefined) throw new Error(`No setup token in the CLI output:\n${printed}`);
  const state: E2eState = { baseUrl, setupToken, email: EMAIL };
  writeFileSync(STATE_FILE, JSON.stringify(state));

  return async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve(undefined);
      else child.once('exit', resolve);
    });
    rmSync(STATE_FILE, { force: true });
    await database.drop();
    await cluster.stop();
  };
}
