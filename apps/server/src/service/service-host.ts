import { type ChildProcess, execFile, fork } from 'node:child_process';
import { basename } from 'node:path';
import { RESTART_EXIT_CODE, SHUTDOWN_MESSAGE } from '../common/server-lifecycle.js';
import {
  DEFAULT_HEALTH_LIMITS,
  type HealthLimits,
  HealthWatch,
  type ProbeResult,
  RECOVERED_AFTER_MS,
  restartDelayMs,
} from './health-watch.js';
import { type HostPhase, type HostState, readHostState, writeHostState } from './host-state.js';

/**
 * The service host (NFR-A04, P0-16b): the program the server's Windows service runs. Before the
 * server starts it waits for the database, runs a restore asked for on the System page and applies
 * pending migrations (`prepare`). Then it runs the server as its child and keeps it running:
 *
 * - started again at once when it ends (within 5 s even after repeated crashes);
 * - ended and started again when it stops answering its health check (`HealthWatch`);
 * - on exit code 75 (a restore was asked for), prepared again first.
 *
 * The host stops the server through Node's IPC channel, so the server can close its connections
 * on Windows, which has no signals; the server also stops when the channel closes (the host died).
 */

export type HostLevel = 'info' | 'warn' | 'error';
export type HostLog = (level: HostLevel, message: string, extra?: Record<string, unknown>) => void;

/** JSON lines in pino's shape, so the server's, the host's and the watchdog's logs read alike. */
export function jsonLog(
  name = 'service-host',
  write: (line: string) => void = (line) => process.stdout.write(line),
): HostLog {
  const levels: Record<HostLevel, number> = { info: 30, warn: 40, error: 50 };
  return (level, message, extra = {}) => {
    write(
      `${JSON.stringify({ level: levels[level], time: Date.now(), name, msg: message, ...extra })}\n`,
    );
  };
}

export interface PrepareContext {
  readonly signal: AbortSignal;
  readonly phase: (
    phase: Extract<HostPhase, 'WAITING_FOR_DATABASE' | 'RESTORING' | 'MIGRATING'>,
  ) => void;
  readonly log: HostLog;
}

export interface ServiceHostOptions {
  /** The server's entry point (`dist/main.js`). */
  readonly serverEntry: string;
  /** The server's whole environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly stateFile: string;
  readonly probe: () => Promise<ProbeResult>;
  /** Everything before the server starts; throwing leaves the server stopped and tries again. */
  readonly prepare: (context: PrepareContext) => Promise<void>;
  readonly log?: HostLog;
  readonly limits?: Partial<HealthLimits>;
  readonly probeIntervalMs?: number;
  readonly heartbeatMs?: number;
  /** How long the server may take to close before it is ended. */
  readonly shutdownGraceMs?: number;
  /** The wait after a failed `prepare`. */
  readonly prepareRetryMs?: number;
  /** Node.js options for the server, e.g. `--enable-source-maps`. */
  readonly execArgv?: readonly string[];
  /** The executable name of a process (to end one the last host left behind), or null. */
  readonly processImage?: (pid: number) => Promise<string | null>;
}

interface ServerExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The executable of a running process, from `tasklist` on Windows and `ps` elsewhere. */
export function systemProcessImage(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    const [command, args] =
      process.platform === 'win32'
        ? ['tasklist', ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH']]
        : ['ps', ['-p', String(pid), '-o', 'comm=']];
    execFile(command, args, { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
      if (error !== null) {
        resolve(null);
        return;
      }
      const text = stdout.trim();
      if (process.platform === 'win32') {
        // "node.exe","1234","Services","0","40,000 K", or a message when there is no such PID.
        const match = /^"([^"]+)","(\d+)"/.exec(text);
        resolve(match?.[2] === String(pid) ? (match[1] ?? null) : null);
      } else {
        resolve(text === '' ? null : text);
      }
    });
  });
}

function sameProgram(image: string, execPath: string): boolean {
  const name = (path: string) => basename(path.replaceAll('\\', '/')).toLowerCase();
  return name(image) === name(execPath);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

export class ServiceHost {
  private readonly log: HostLog;
  private readonly limits: HealthLimits;
  private readonly stopping = new AbortController();
  private state: HostState;
  private child: ChildProcess | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ServiceHostOptions) {
    this.log = options.log ?? jsonLog();
    this.limits = { ...DEFAULT_HEALTH_LIMITS, ...options.limits };
    const now = new Date().toISOString();
    this.state = {
      format: 1,
      hostPid: process.pid,
      execPath: process.execPath,
      phase: 'STARTING',
      phaseSince: now,
      heartbeatAt: now,
      serverPid: null,
      serverStartedAt: null,
      restarts: 0,
      lastExit: null,
      lastError: null,
    };
  }

  /** Asked through a call, so a check after an await is not taken as already known. */
  private isStopping(): boolean {
    return this.stopping.signal.aborted;
  }

  /** The state as last written. */
  get current(): HostState {
    return this.state;
  }

  /** Runs until `stop()`. */
  start(): Promise<void> {
    this.running ??= this.run();
    return this.running;
  }

  /** Stops the server (gracefully, then by force) and the host's loop. */
  async stop(): Promise<void> {
    if (!this.stopping.signal.aborted) {
      this.log('info', 'Stopping');
      this.stopping.abort();
      this.setPhase('STOPPING');
      await this.endServer();
    }
    await this.running;
  }

  private async run(): Promise<void> {
    this.heartbeat = setInterval(() => {
      this.save();
    }, this.options.heartbeatMs ?? 2_000);
    this.heartbeat.unref();
    try {
      this.save();
      await this.endLeftoverServer();
      let failures = 0;
      let prepared = false;
      while (!this.isStopping()) {
        if (!prepared) {
          try {
            await this.options.prepare({
              signal: this.stopping.signal,
              phase: (phase) => {
                this.setPhase(phase);
              },
              log: this.log,
            });
            this.state = { ...this.state, lastError: null };
            prepared = true;
          } catch (error) {
            if (this.isStopping()) break;
            const message = error instanceof Error ? error.message : String(error);
            this.log('error', 'The server cannot start yet', { error: message });
            this.state = { ...this.state, lastError: message };
            this.save();
            await sleep(this.options.prepareRetryMs ?? 30_000, this.stopping.signal);
            continue;
          }
        }
        if (this.isStopping()) break;
        const startedAt = Date.now();
        const { exit, reason, healthyFor } = await this.runServer();
        if (this.isStopping()) break;
        this.state = {
          ...this.state,
          serverPid: null,
          restarts: this.state.restarts + 1,
          lastExit: {
            at: new Date().toISOString(),
            code: exit.code,
            signal: exit.signal,
            reason,
          },
        };
        if (exit.code === RESTART_EXIT_CODE) {
          // Asked for (a restore): prepare again, then start at once.
          this.log('info', 'The server asked to be started again');
          failures = 0;
          prepared = false;
          this.setPhase('RESTARTING');
          continue;
        }
        failures = healthyFor >= RECOVERED_AFTER_MS ? 1 : failures + 1;
        const delay = restartDelayMs(failures);
        this.log('warn', 'The server ended; starting it again', {
          code: exit.code,
          signal: exit.signal,
          reason,
          ranForMs: Date.now() - startedAt,
          delayMs: delay,
        });
        this.setPhase('RESTARTING');
        await sleep(delay, this.stopping.signal);
      }
    } finally {
      clearInterval(this.heartbeat);
      this.state = { ...this.state, serverPid: null };
      this.setPhase('STOPPED');
      await this.writing;
    }
  }

  /** Runs the server until it ends; ends it when its health says so. */
  private async runServer(): Promise<{
    exit: ServerExit;
    reason: string | null;
    healthyFor: number;
  }> {
    const child = fork(this.options.serverEntry, [], {
      env: { ...this.options.env },
      execArgv: [...(this.options.execArgv ?? [])],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    });
    this.child = child;
    const exited = new Promise<ServerExit>((resolve) => {
      child.once('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });
    // An IPC error (the child already gone) must not end the host.
    child.on('error', (error) => {
      this.log('warn', 'Server process error', { error: error.message });
    });
    const startedAt = Date.now();
    this.state = {
      ...this.state,
      serverPid: child.pid ?? null,
      serverStartedAt: new Date(startedAt).toISOString(),
    };
    this.setPhase('RUNNING');
    this.log('info', 'Server started', { pid: child.pid });

    const watch = new HealthWatch(startedAt, this.limits);
    let reason: string | null = null;
    // Ends with the server or the host, whichever is first, without waiting for a probe.
    const watcher = new AbortController();
    const endWatching = () => {
      watcher.abort();
    };
    this.stopping.signal.addEventListener('abort', endWatching, { once: true });
    void exited.then(endWatching);
    const ended = () => watcher.signal.aborted;
    void (async () => {
      while (!ended()) {
        await sleep(this.options.probeIntervalMs ?? 2_000, watcher.signal);
        if (ended()) return;
        const result = await this.options.probe();
        if (ended()) return;
        watch.record(result, Date.now());
        const verdict = watch.verdict(Date.now());
        if (verdict.kind === 'restart') {
          reason = verdict.reason;
          this.log('error', 'The server is not responding; ending it', { reason });
          child.kill('SIGKILL');
          return;
        }
      }
    })();
    const exit = await exited;
    this.stopping.signal.removeEventListener('abort', endWatching);
    this.child = undefined;
    return { exit, reason, healthyFor: watch.healthyFor(Date.now()) };
  }

  /** Asks the server to close; ends it if it has not after the grace period. */
  private async endServer(): Promise<void> {
    const child = this.child;
    if (child?.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => {
        resolve();
      }),
    );
    if (child.connected) {
      child.send(SHUTDOWN_MESSAGE, (error) => {
        if (error !== null) child.kill('SIGKILL');
      });
    } else {
      child.kill('SIGKILL');
    }
    const timer = setTimeout(() => {
      this.log('warn', 'The server did not close in time; ending it');
      child.kill('SIGKILL');
    }, this.options.shutdownGraceMs ?? 8_000);
    await exited;
    clearTimeout(timer);
  }

  /**
   * A server the last host left running (the host itself was ended) would hold the ports, so the
   * new one could never start. It is ended if it is still the same program.
   */
  private async endLeftoverServer(): Promise<void> {
    const previous = await readHostState(this.options.stateFile);
    const pid = previous?.serverPid;
    if (previous === null || pid === null || pid === undefined) return;
    if (previous.hostPid === process.pid || pid === process.pid) return;
    if (isAlive(previous.hostPid) || !isAlive(pid)) return;
    const image = await (this.options.processImage ?? systemProcessImage)(pid);
    if (image === null || !sameProgram(image, previous.execPath)) return;
    this.log('warn', 'Ending the server the last host left running', { pid });
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone in the meantime.
    }
  }

  private setPhase(phase: HostPhase): void {
    if (this.state.phase !== phase) {
      this.state = { ...this.state, phase, phaseSince: new Date().toISOString() };
    }
    this.save();
  }

  /** Writes the state with a fresh heartbeat; writes never overlap. */
  private save(): void {
    this.state = { ...this.state, heartbeatAt: new Date().toISOString() };
    const snapshot = this.state;
    this.writing = this.writing
      .then(() => writeHostState(this.options.stateFile, snapshot))
      .catch((error: unknown) => {
        this.log('warn', 'Could not write the state file', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
}
