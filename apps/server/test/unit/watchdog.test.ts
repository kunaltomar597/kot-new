import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEALTH_LIMITS,
  HealthWatch,
  RECOVERED_AFTER_MS,
  restartDelayMs,
} from '../../src/service/health-watch.js';
import type { HostState } from '../../src/service/host-state.js';
import {
  endMaintenance,
  MAX_MAINTENANCE_MINUTES,
  maintenancePath,
  readMaintenance,
  startMaintenance,
} from '../../src/service/maintenance.js';
import {
  type ServiceControl,
  type ServiceState,
  Watchdog,
  type WatchdogObservation,
  WatchdogPolicy,
} from '../../src/service/watchdog.js';
import {
  parseScPid,
  parseScState,
  type RunCommand,
  WindowsServiceControl,
} from '../../src/service/windows-services.js';

describe('[NFR-A04] when the host gives up on a running server', () => {
  it('waits for the first answer, then ends a server that stops answering', () => {
    const watch = new HealthWatch(0);
    expect(watch.verdict(59_000)).toEqual({ kind: 'starting' });
    expect(watch.verdict(DEFAULT_HEALTH_LIMITS.startupGraceMs + 1)).toMatchObject({
      kind: 'restart',
      reason: 'no answer within 60 s of starting',
    });
    watch.record('ok', 5_000);
    watch.record('unanswered', 7_000);
    expect(watch.verdict(20_000)).toEqual({ kind: 'healthy' });
    expect(watch.verdict(5_000 + DEFAULT_HEALTH_LIMITS.hungAfterMs + 1)).toMatchObject({
      kind: 'restart',
      reason: 'no answer for 20 s',
    });
  });

  it('gives a server whose database is down longer, and counts healthy time', () => {
    const watch = new HealthWatch(0);
    watch.record('ok', 1_000);
    expect(watch.healthyFor(61_000)).toBe(60_000);
    watch.record('degraded', 2_000);
    expect(watch.healthyFor(3_000)).toBe(0);
    watch.record('degraded', 100_000);
    expect(watch.verdict(100_000)).toEqual({ kind: 'degraded' });
    watch.record('degraded', 122_001);
    expect(watch.verdict(122_001)).toMatchObject({ kind: 'restart', reason: /database/ });
    watch.record('ok', 123_000);
    expect(watch.verdict(123_000)).toEqual({ kind: 'healthy' });
  });

  it('starts a crashed server again within 5 s, however often it crashes', () => {
    expect(restartDelayMs(1)).toBe(500);
    expect([1, 2, 3, 4, 5, 50].map(restartDelayMs).every((ms) => ms <= 5_000)).toBe(true);
    expect(restartDelayMs(50)).toBe(5_000);
    expect(RECOVERED_AFTER_MS).toBe(60_000);
  });
});

function host(heartbeatAt: string): HostState {
  return {
    format: 1,
    hostPid: 10,
    execPath: 'node.exe',
    phase: 'RUNNING',
    phaseSince: heartbeatAt,
    heartbeatAt,
    serverPid: 11,
    serverStartedAt: heartbeatAt,
    restarts: 0,
    lastExit: null,
    lastError: null,
  };
}

function seen(overrides: Partial<WatchdogObservation>): WatchdogObservation {
  return {
    at: 0,
    database: 'RUNNING',
    server: 'RUNNING',
    host: host('2026-10-04T10:00:00.000Z'),
    serverAnswers: true,
    maintenance: false,
    ...overrides,
  };
}

describe('[NFR-A04] the watchdog', () => {
  it('starts stopped services, not more often than the cool-down', () => {
    const policy = new WatchdogPolicy();
    expect(policy.decide(seen({ at: 0, database: 'STOPPED', server: 'STOPPED' }))).toEqual([
      { kind: 'start', service: 'database', reason: 'the database service is stopped' },
      { kind: 'start', service: 'server', reason: 'the server service is stopped' },
    ]);
    expect(policy.decide(seen({ at: 10_000, database: 'STOPPED', server: 'STOPPED' }))).toEqual([]);
    expect(policy.decide(seen({ at: 30_000, server: 'STOPPED' }))).toHaveLength(1);
  });

  it('restarts the server when its host is silent and the server does not answer', () => {
    const policy = new WatchdogPolicy();
    const stuck = host('2026-10-04T10:00:00.000Z');
    expect(policy.decide(seen({ at: 0, host: stuck, serverAnswers: false }))).toEqual([]);
    expect(policy.decide(seen({ at: 44_000, host: stuck, serverAnswers: false }))).toEqual([]);
    expect(policy.decide(seen({ at: 46_000, host: stuck, serverAnswers: false }))).toEqual([
      {
        kind: 'restart',
        service: 'server',
        reason: 'the service host has been silent for 46 s',
      },
    ]);
  });

  it('never restarts a server that answers, nor one whose host is busy (a long restore)', () => {
    const policy = new WatchdogPolicy();
    const stuck = host('2026-10-04T10:00:00.000Z');
    expect(policy.decide(seen({ at: 0, host: stuck }))).toEqual([]);
    expect(policy.decide(seen({ at: 120_000, host: stuck, serverAnswers: true }))).toEqual([]);
    const busy = new WatchdogPolicy();
    for (let at = 0; at <= 600_000; at += 5_000) {
      const beat = new Date(Date.UTC(2026, 9, 4, 10, 0, 0, at)).toISOString();
      expect(busy.decide(seen({ at, host: host(beat), serverAnswers: false }))).toEqual([]);
    }
  });

  it('restarts a server service stuck starting or stopping, never the database', () => {
    const policy = new WatchdogPolicy();
    policy.decide(seen({ at: 0, server: 'STOP_PENDING', database: 'START_PENDING' }));
    expect(
      policy.decide(seen({ at: 121_000, server: 'STOP_PENDING', database: 'START_PENDING' })),
    ).toEqual([
      {
        kind: 'restart',
        service: 'server',
        reason: 'the server service has been STOP_PENDING for 121 s',
      },
    ]);
  });

  it('leaves everything alone during maintenance', () => {
    const policy = new WatchdogPolicy();
    expect(
      policy.decide(seen({ database: 'STOPPED', server: 'STOPPED', maintenance: true })),
    ).toEqual([]);
  });

  it('acts through the service manager and reports a missing service once', async () => {
    const states: Record<string, ServiceState> = { RPDatabase: 'RUNNING', RPServer: 'STOPPED' };
    const calls: string[] = [];
    const control: ServiceControl = {
      state: (name) => Promise.resolve(states[name] ?? 'MISSING'),
      start: (name) => {
        calls.push(`start ${name}`);
        return name === 'RPServer' ? Promise.reject(new Error('1053')) : Promise.resolve();
      },
      restart: (name) => {
        calls.push(`restart ${name}`);
        return Promise.resolve();
      },
    };
    const log: string[] = [];
    let clock = 0;
    const watchdog = new Watchdog({
      control,
      services: { database: 'RPDatabase', server: 'RPServer' },
      readHost: () => Promise.resolve(null),
      probe: () => Promise.resolve('unanswered'),
      maintenance: () => Promise.resolve(false),
      log: (level, message) => log.push(`${level}: ${message}`),
      clock: () => clock,
    });
    expect(await watchdog.check()).toHaveLength(1);
    expect(calls).toEqual(['start RPServer']);
    expect(log).toContain('error: The service did not do as asked');
    states.RPDatabase = 'MISSING';
    clock = 1_000;
    await watchdog.check();
    await watchdog.check();
    expect(log.filter((line) => line.includes('not installed'))).toHaveLength(1);
  });

  it('keeps checking on a timer until stopped', async () => {
    let checks = 0;
    const watchdog = new Watchdog({
      control: {
        state: () => {
          checks += 1;
          return Promise.resolve('RUNNING');
        },
        start: () => Promise.resolve(),
        restart: () => Promise.resolve(),
      },
      services: { database: 'RPDatabase', server: 'RPServer' },
      readHost: () => Promise.resolve(null),
      probe: () => Promise.resolve('ok'),
      maintenance: () => Promise.resolve(false),
      log: () => undefined,
      intervalMs: 10,
    });
    watchdog.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await watchdog.stop();
    const after = checks;
    expect(after).toBeGreaterThan(4);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(checks).toBe(after);
  });
});

const QUERY_RUNNING = `
SERVICE_NAME: RPServer
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)
        SERVICE_EXIT_CODE  : 0  (0x0)
        CHECKPOINT         : 0x0
        WAIT_HINT          : 0x0
        PID                : 4321
        FLAGS              :
`;

describe('[NFR-A04] Windows service control', () => {
  it('reads the state and process from sc.exe', () => {
    expect(parseScState(QUERY_RUNNING)).toBe('RUNNING');
    expect(parseScState(QUERY_RUNNING.replace('4  RUNNING', '1  STOPPED'))).toBe('STOPPED');
    expect(parseScState(QUERY_RUNNING.replace('4  RUNNING', '3  STOP_PENDING'))).toBe(
      'STOP_PENDING',
    );
    expect(parseScState('garbage')).toBe('UNKNOWN');
    expect(parseScPid(QUERY_RUNNING)).toBe(4321);
    expect(parseScPid(QUERY_RUNNING.replace('4321', '0'))).toBeNull();
  });

  it('starts, stops and, when a service will not stop, ends its processes', async () => {
    const calls: string[] = [];
    let stopped = false;
    const run: RunCommand = (program, args) => {
      const command = `${program.split(/[\\/]/).at(-1) ?? ''} ${args.join(' ')}`;
      calls.push(command);
      if (args[0] === 'query' && args[1] === 'Missing') {
        return Promise.resolve({ code: 1060, output: 'OpenService FAILED 1060' });
      }
      if (args[0] === 'query' || args[0] === 'queryex') {
        return Promise.resolve({
          code: 0,
          output: stopped ? QUERY_RUNNING.replace('4  RUNNING', '1  STOPPED') : QUERY_RUNNING,
        });
      }
      if (program.endsWith('taskkill.exe')) stopped = true;
      if (args[0] === 'start') return Promise.resolve({ code: 1056, output: 'already running' });
      return Promise.resolve({ code: 0, output: '' });
    };
    const control = new WindowsServiceControl({
      run,
      systemRoot: 'C:\\Windows',
      stopWaitMs: 50,
      pollMs: 10,
    });
    expect(await control.state('Missing')).toBe('MISSING');
    expect(await control.state('RPServer')).toBe('RUNNING');
    await control.start('RPServer');
    await control.restart('RPServer');
    expect(calls).toContain('sc.exe stop RPServer');
    expect(calls).toContain('taskkill.exe /F /T /PID 4321');
    expect(calls.at(-1)).toBe('sc.exe start RPServer');
  });

  it('ends a service stuck starting, which refuses to be stopped', async () => {
    const calls: string[] = [];
    let stopped = false;
    const control = new WindowsServiceControl({
      run: (program, args) => {
        calls.push(`${program.split(/[\\/]/).at(-1) ?? ''} ${args.join(' ')}`);
        if (args[0] === 'stop') return Promise.resolve({ code: 1061, output: 'cannot accept' });
        if (program.endsWith('taskkill.exe')) stopped = true;
        if (args[0] === 'query' || args[0] === 'queryex') {
          return Promise.resolve({
            code: 0,
            output: QUERY_RUNNING.replace(
              '4  RUNNING',
              stopped ? '1  STOPPED' : '2  START_PENDING',
            ),
          });
        }
        return Promise.resolve({ code: 0, output: '' });
      },
      stopWaitMs: 1_000,
      pollMs: 10,
    });
    await control.restart('RPServer');
    expect(calls).toEqual([
      'sc.exe stop RPServer',
      'sc.exe queryex RPServer',
      'taskkill.exe /F /T /PID 4321',
      'sc.exe query RPServer',
      'sc.exe start RPServer',
    ]);
  });
});

describe('the maintenance flag', () => {
  it('holds until it expires, and never longer than the maximum', async () => {
    const path = maintenancePath(mkdtempSync(join(tmpdir(), 'rp-maint-')));
    const now = new Date('2026-10-04T10:00:00Z');
    expect(await readMaintenance(path, now)).toBeNull();
    await startMaintenance(path, { minutes: 30, reason: 'update 1.5.0', now });
    expect(await readMaintenance(path, now)).toMatchObject({ reason: 'update 1.5.0' });
    expect(await readMaintenance(path, new Date('2026-10-04T10:31:00Z'))).toBeNull();
    const capped = await startMaintenance(path, { minutes: 10_000, reason: 'x', now });
    expect(Date.parse(capped.until) - now.getTime()).toBe(MAX_MAINTENANCE_MINUTES * 60_000);
    writeFileSync(path, JSON.stringify({ until: '2030-01-01T00:00:00Z', reason: 'forever' }));
    expect(await readMaintenance(path, now)).toBeNull();
    await expect(startMaintenance(path, { minutes: 0, reason: 'x' })).rejects.toThrow();
    await endMaintenance(path);
    expect(await readMaintenance(path, now)).toBeNull();
  });
});
