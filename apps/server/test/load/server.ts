import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import {
  DEFAULT_PRINT_QUEUE_OPTIONS,
  PRINT_QUEUE_OPTIONS,
} from '../../src/printing/print-queue.service.js';
import {
  DEFAULT_RELAY_ORDERS_OPTIONS,
  RELAY_ORDERS_OPTIONS,
} from '../../src/relay/relay-orders.service.js';
import {
  DEFAULT_RELAY_SYNC_OPTIONS,
  RELAY_SYNC_OPTIONS,
} from '../../src/relay/relay-sync.service.js';
import { TlsService } from '../../src/tls/tls.service.js';
import { createTestApp } from '../helpers/test-app.js';
import { tlsFetch } from './tls-fetch.js';

/** The local server under load (P8-01a), reached as devices reach it: HTTPS, WSS and MQTTS. */
export interface LoadTarget {
  readonly url: string;
  readonly mqttUrl: string;
  /** The installation's CA, which every device pins. */
  readonly ca: string;
  /** The server's own process, when it has one. */
  readonly pid: number | undefined;
  /**
   * Stops the server, killed as in a crash when it has a process of its own, and starts it again
   * on the same ports and data. `stoppedAt` and `healthyAt` are `performance.now()` times.
   */
  restart(): Promise<{ readonly stoppedAt: number; readonly healthyAt: number }>;
  stop(): Promise<void>;
}

const SERVER_MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'main.js');

export async function freePort(): Promise<number> {
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

/** Waits for `GET /health` over the pinned CA; returns when it answered. */
async function healthy(url: string, ca: string, alive: () => boolean): Promise<number> {
  const get = tlsFetch(ca);
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    if (!alive()) throw new Error('The server stopped while starting');
    try {
      if ((await get(`${url}/api/v1/health`)).ok) return performance.now();
    } catch {
      // Not listening yet.
    }
    await sleep(100);
  }
  throw new Error('The server did not answer within 120 s');
}

/**
 * The built server (`apps/server/dist/main.js`, after `pnpm build`) in a process of its own, as
 * the Windows service runs it: TLS on, the pager broker on, its log in `logFile`. `NODE_ENV` is
 * `development`: `production` insists on the nightly backup and a licence, and `test` turns the
 * print queue off. The database and the data folder were prepared by the set-up. With `relayUrl`
 * it syncs with the QR relay there (P8-01b), with the restaurant PC's own timings.
 */
export async function startBuiltServer(options: {
  readonly databaseUrl: string;
  readonly dataDir: string;
  readonly ca: string;
  readonly logFile: string;
  readonly relayUrl?: string;
}): Promise<LoadTarget> {
  const [port, mqttPort] = [await freePort(), await freePort()];
  const url = `https://127.0.0.1:${String(port)}`;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(RP_|DATABASE_URL$|NODE_ENV$|HOST$|PORT$|LOG_)/.test(key),
    ),
  );
  let child: ChildProcess | undefined;
  const start = async (): Promise<number> => {
    const log = openSync(options.logFile, 'a');
    try {
      child = spawn(process.execPath, [SERVER_MAIN], {
        env: {
          ...env,
          NODE_ENV: 'development',
          HOST: '127.0.0.1',
          PORT: String(port),
          DATABASE_URL: options.databaseUrl,
          RP_DATA_DIR: options.dataDir,
          RP_TLS: 'on',
          RP_MQTT: 'on',
          RP_MQTT_PORT: String(mqttPort),
          RP_BACKUPS: 'off',
          ...(options.relayUrl !== undefined && { RP_RELAY_URL: options.relayUrl }),
          LOG_LEVEL: 'warn',
        },
        stdio: ['ignore', log, log],
      });
    } finally {
      closeSync(log);
    }
    const running = child;
    return healthy(url, options.ca, () => running.exitCode === null && running.signalCode === null);
  };
  const stopped = (server: ChildProcess | undefined, signal: NodeJS.Signals) =>
    new Promise<void>((resolve) => {
      if (server?.exitCode !== null || server.signalCode !== null) {
        resolve();
        return;
      }
      server.once('exit', () => {
        resolve();
      });
      server.kill(signal);
    });
  await start();
  return {
    url,
    mqttUrl: `mqtts://127.0.0.1:${String(mqttPort)}`,
    ca: options.ca,
    get pid() {
      return child?.pid;
    },
    async restart() {
      const stoppedAt = performance.now();
      await stopped(child, 'SIGKILL');
      return { stoppedAt, healthyAt: await start() };
    },
    stop: () => stopped(child, 'SIGTERM'),
  };
}

/**
 * The server in this process (the integration suite's short run), on fixed ports so it can be
 * started again where the devices expect it. Its print queue runs as on the restaurant PC; with
 * `relayUrl` it syncs with the QR relay there, starting at once rather than after the seconds a
 * restaurant PC gives itself to settle.
 */
export async function startInProcessServer(options: {
  readonly databaseUrl: string;
  readonly dataDir: string;
  readonly relayUrl?: string;
}): Promise<
  LoadTarget & { readonly app: () => INestApplication; readonly errors: readonly string[] }
> {
  const [port, mqttPort] = [await freePort(), await freePort()];
  // What the server logs as an error or worse (pino levels 50 and 60).
  const errors: string[] = [];
  const logDestination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString().split('\n')) {
        if (/"level":(50|60)/.test(line)) errors.push(line);
      }
      done();
    },
  });
  const create = () =>
    createTestApp({
      databaseUrl: options.databaseUrl,
      port,
      logDestination,
      config: {
        dataDir: options.dataDir,
        tls: true,
        mqtt: 'on',
        mqttPort,
        host: '127.0.0.1',
        logLevel: 'error',
        ...(options.relayUrl !== undefined && { relayUrl: options.relayUrl }),
      },
      overrides: [
        { provide: PRINT_QUEUE_OPTIONS, useValue: DEFAULT_PRINT_QUEUE_OPTIONS },
        {
          provide: RELAY_SYNC_OPTIONS,
          useValue: { ...DEFAULT_RELAY_SYNC_OPTIONS, firstDelayMs: 200 },
        },
        {
          provide: RELAY_ORDERS_OPTIONS,
          useValue: { ...DEFAULT_RELAY_ORDERS_OPTIONS, firstDelayMs: 200, realtimeDelayMs: 200 },
        },
      ],
    });
  let app = await create();
  const ca = app.get(TlsService).ca()?.certificate;
  if (ca === undefined) throw new Error('The server has no CA');
  const url = `https://127.0.0.1:${String(port)}`;
  return {
    url,
    mqttUrl: `mqtts://127.0.0.1:${String(mqttPort)}`,
    ca,
    pid: undefined,
    app: () => app,
    errors,
    async restart() {
      const stoppedAt = performance.now();
      await app.close();
      app = await create();
      return { stoppedAt, healthyAt: await healthy(url, ca, () => true) };
    },
    stop: () => app.close(),
  };
}
