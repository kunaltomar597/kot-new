import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { probeHealth } from '../../src/service/health-probe.js';
import { readHostState, writeHostState } from '../../src/service/host-state.js';
import {
  type PrepareContext,
  ServiceHost,
  type ServiceHostOptions,
} from '../../src/service/service-host.js';
import { until } from '../helpers/wait.js';

const FAKE_SERVER = fileURLToPath(new URL('../fixtures/service/fake-server.mjs', import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
  });
}

const hosts: ServiceHost[] = [];
const folders: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function setUp(
  behaviour: string,
  overrides: Partial<ServiceHostOptions> = {},
): Promise<{
  host: ServiceHost;
  dir: string;
  port: number;
  stateFile: string;
  starts: () => number[];
  prepared: () => number;
  log: string[];
}> {
  const dir = mkdtempSync(join(tmpdir(), 'rp-host-'));
  folders.push(dir);
  const port = await freePort();
  const stateFile = join(dir, 'run', 'service-host.json');
  const log: string[] = [];
  let prepared = 0;
  const host = new ServiceHost({
    serverEntry: FAKE_SERVER,
    env: { PORT: String(port), FAKE_DIR: dir, FAKE_BEHAVIOUR: behaviour },
    stateFile,
    probe: () => probeHealth({ port, timeoutMs: 300 }),
    prepare: (context: PrepareContext) => {
      prepared += 1;
      context.phase('MIGRATING');
      return Promise.resolve();
    },
    limits: { hungAfterMs: 1_500, startupGraceMs: 5_000, degradedAfterMs: 1_500 },
    probeIntervalMs: 100,
    heartbeatMs: 200,
    shutdownGraceMs: 2_000,
    prepareRetryMs: 200,
    log: (level, message) => log.push(`${level}: ${message}`),
    ...overrides,
  });
  hosts.push(host);
  const starts = () =>
    existsSync(join(dir, 'starts.log'))
      ? readFileSync(join(dir, 'starts.log'), 'utf8').split('\n').filter(Boolean).map(Number)
      : [];
  return { host, dir, port, stateFile, starts, prepared: () => prepared, log };
}

describe('[NFR-A04] the service host keeps the server running', () => {
  it('prepares, starts the server and records it in the state file', async () => {
    const { host, port, stateFile, starts, prepared } = await setUp('');
    void host.start();
    await until(async () => (await probeHealth({ port })) === 'ok', 10_000, 'the server');
    expect(prepared()).toBe(1);
    const state = await until(async () => {
      const read = await readHostState(stateFile);
      return read?.phase === 'RUNNING' ? read : undefined;
    });
    expect(state).toMatchObject({ hostPid: process.pid, serverPid: starts()[0], restarts: 0 });
    expect(Date.now() - Date.parse(state.heartbeatAt)).toBeLessThan(2_000);
  });

  it('starts a crashed server again within 10 s', async () => {
    const { host, port, starts, prepared } = await setUp('');
    void host.start();
    await until(async () => (await probeHealth({ port })) === 'ok', 10_000, 'the server');
    const [first] = starts();
    const killedAt = Date.now();
    process.kill(first!, 'SIGKILL');
    await until(() => starts().length === 2, 10_000, 'a second start');
    await until(async () => (await probeHealth({ port })) === 'ok', 10_000, 'the new server');
    expect(Date.now() - killedAt).toBeLessThan(10_000);
    // A crash restarts the server without preparing again (no restore or migrations).
    expect(prepared()).toBe(1);
    expect(host.current.restarts).toBe(1);
    expect(host.current.lastExit).toMatchObject({ signal: 'SIGKILL', reason: null });
  });

  it('ends a server that stops answering and starts it again', async () => {
    const { host, port, starts, log } = await setUp('hang-first');
    void host.start();
    await until(() => starts().length === 2, 15_000, 'the hung server to be replaced');
    await until(async () => (await probeHealth({ port })) === 'ok', 10_000, 'the new server');
    expect(host.current.lastExit?.reason).toMatch(/no answer for \d+ s/);
    expect(log.some((line) => line.includes('not responding'))).toBe(true);
  });

  it('starts a server whose database stays down again', async () => {
    const { host, starts } = await setUp('degraded');
    void host.start();
    await until(() => starts().length === 2, 15_000, 'a restart');
    expect(host.current.lastExit?.reason).toMatch(/database unavailable/);
  });

  it('[DATA-004] prepares again (the restore) when the server exits with 75', async () => {
    const { host, port, starts, prepared } = await setUp('restart-first');
    void host.start();
    await until(() => starts().length === 2, 10_000, 'the restart');
    await until(async () => (await probeHealth({ port })) === 'ok', 10_000, 'the server');
    expect(prepared()).toBe(2);
    expect(host.current.lastExit?.code).toBe(75);
  });

  it('keeps the server stopped while preparing fails, and starts it once it works', async () => {
    let attempts = 0;
    const { host, port, stateFile } = await setUp('', {
      prepare: () => {
        attempts += 1;
        return attempts < 3
          ? Promise.reject(new Error('Migration 2026_x failed and was undone'))
          : Promise.resolve();
      },
    });
    void host.start();
    const failing = await until(async () => {
      const read = await readHostState(stateFile);
      return read?.lastError !== null && read?.lastError !== undefined ? read : undefined;
    });
    expect(failing.lastError).toMatch(/Migration 2026_x failed/);
    expect(failing.serverPid).toBeNull();
    await until(async () => (await probeHealth({ port })) === 'ok', 10_000, 'the server');
    expect(attempts).toBe(3);
    expect(host.current.lastError).toBeNull();
  });

  it('stops the server over IPC so it can close, and records the stop', async () => {
    const { host, dir, port, starts, stateFile } = await setUp('');
    void host.start();
    await until(async () => (await probeHealth({ port })) === 'ok', 10_000, 'the server');
    const [pid] = starts();
    await host.stop();
    expect(readFileSync(join(dir, `closed-${String(pid)}`), 'utf8')).toBe('shutdown');
    expect(await readHostState(stateFile)).toMatchObject({ phase: 'STOPPED', serverPid: null });
    expect(starts()).toHaveLength(1);
  });

  it('ends a server that does not close in time', async () => {
    const { host, port, starts } = await setUp('ignore-stop', { shutdownGraceMs: 300 });
    void host.start();
    await until(async () => (await probeHealth({ port })) === 'ok', 10_000, 'the server');
    const [pid] = starts();
    await host.stop();
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  it('ends a server the last host left running, so the ports are free', async () => {
    const { host, dir, port, stateFile, starts } = await setUp('', {
      processImage: () => Promise.resolve('node'),
    });
    // A server from a host that is gone: started outside any host, still holding the port.
    const leftover = spawn(process.execPath, [FAKE_SERVER], {
      env: { ...process.env, PORT: String(port), FAKE_DIR: dir, FAKE_BEHAVIOUR: '' },
      stdio: 'ignore',
    });
    await until(async () => (await probeHealth({ port })) === 'ok', 10_000, 'the leftover');
    const gone = new Promise((resolve) => leftover.once('exit', resolve));
    const now = new Date().toISOString();
    await writeHostState(stateFile, {
      format: 1,
      hostPid: 999_999,
      execPath: process.execPath,
      phase: 'RUNNING',
      phaseSince: now,
      heartbeatAt: now,
      serverPid: leftover.pid!,
      serverStartedAt: now,
      restarts: 0,
      lastExit: null,
      lastError: null,
    });
    void host.start();
    await gone;
    await until(() => starts().length === 2, 10_000, 'the host to start its own');
    await until(async () => (await probeHealth({ port })) === 'ok', 10_000, 'its server');
  });
});
