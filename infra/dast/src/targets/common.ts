import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { HeaderRule } from '../credentials.js';
import type { ScanTarget } from '../plan.js';

/** The repository's root. */
export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** A surface started for its scan. */
export interface RunningTarget {
  readonly target: ScanTarget;
  /** The OpenAPI document to copy into the run's folder (as `target.openApi.file`). */
  readonly openApiSource?: string;
  /** The headers to send now; `keepFresh` is called again while ZAP scans. */
  headerRules(): readonly HeaderRule[];
  /**
   * Called every half minute while ZAP scans: renews whatever the scan may have ended (a
   * session signed out, an access token past its 15 minutes). Resolves true when the rules
   * changed.
   */
  keepFresh(): Promise<boolean>;
  stop(): Promise<void>;
}

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

/** Waits until `ready` resolves true, while the process is alive. */
export async function waitUntil(
  what: string,
  ready: () => Promise<boolean>,
  child?: ChildProcess,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child !== undefined && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`${what} stopped while starting (see its log)`);
    }
    try {
      if (await ready()) return;
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  throw new Error(`${what} was not ready within ${String(timeoutMs / 1000)} s`);
}

/**
 * Starts a built service in a process of its own, its output in `logFile`, with only the
 * environment given (none of the developer's own `DATABASE_URL`, `RP_*` or `CP_*`).
 */
export function startService(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env: Record<string, string>;
    readonly logFile: string;
  },
): ChildProcess {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(RP_|CP_|DATABASE_URL$|NODE_ENV$|HOST$|PORT$|LOG_|RELAY_)/.test(key),
    ),
  );
  const log = openSync(options.logFile, 'a');
  try {
    return spawn(command, args, {
      cwd: options.cwd,
      env: { ...inherited, ...options.env },
      stdio: ['ignore', log, log],
    });
  } finally {
    closeSync(log);
  }
}

export async function stopService(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
