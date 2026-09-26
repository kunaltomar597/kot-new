import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { CONSOLE_DIST, SERVER_DIST } from './paths.js';

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

async function waitUntilHealthy(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`The server exited with ${String(child.exitCode)}`);
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('The server did not become healthy within 30 s');
}

/**
 * Starts the built local server (`apps/server/dist/main.js`) serving the built console, on the
 * database and data folder prepared by the global setup. Pass the port again to restart it where
 * browsers expect it.
 */
export async function startServer(port?: number): Promise<RunningServer> {
  const databaseUrl = process.env.RP_E2E_DATABASE_URL;
  const dataDir = process.env.RP_E2E_DATA_DIR;
  if (databaseUrl === undefined || dataDir === undefined) {
    throw new Error('Run the e2e tests through Playwright (global setup prepares the database)');
  }
  const listenPort = port ?? (await freePort());
  const url = `http://127.0.0.1:${String(listenPort)}`;
  const child = spawn('node', [join(SERVER_DIST, 'main.js')], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(listenPort),
      DATABASE_URL: databaseUrl,
      RP_DATA_DIR: dataDir,
      RP_CONSOLE_DIR: CONSOLE_DIST,
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitUntilHealthy(url, child);
  return {
    url,
    port: listenPort,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => {
          resolve();
        });
        child.kill('SIGTERM');
      }),
  };
}
