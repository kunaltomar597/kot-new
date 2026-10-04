import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { SERVICE_STATES, type ServiceControl, type ServiceState } from './watchdog.js';

/**
 * Windows' service manager through `sc.exe` and `taskkill.exe` (P0-16b), which start in a few
 * milliseconds, unlike PowerShell.
 */

/** `sc query` and `sc queryex` print this when the service is not installed. */
const NOT_INSTALLED = 1060;
/** `sc start` on a service that is already running. */
const ALREADY_RUNNING = 1056;
/** `sc stop` on a service that is not running. */
const NOT_ACTIVE = 1062;

const STATE_LINE = new RegExp(`:\\s*[1-7]\\s+(${SERVICE_STATES.slice(0, 7).join('|')})\\b`);

/** The state in `sc query` output. The keywords are not translated on other Windows languages. */
export function parseScState(output: string): ServiceState {
  const match = STATE_LINE.exec(output);
  return (match?.[1] as ServiceState | undefined) ?? 'UNKNOWN';
}

/** The service's process in `sc queryex` output; null when it has none (0) or none is shown. */
export function parseScPid(output: string): number | null {
  const match = /\bPID\s*:\s*(\d+)/.exec(output);
  const pid = match === null ? 0 : Number(match[1]);
  return pid > 0 ? pid : null;
}

interface Run {
  readonly code: number;
  readonly output: string;
}

export type RunCommand = (program: string, args: readonly string[]) => Promise<Run>;

const runCommand: RunCommand = (program, args) =>
  new Promise((resolve, reject) => {
    execFile(
      program,
      [...args],
      { windowsHide: true, timeout: 30_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : (error as { code?: unknown }).code;
        if (typeof code !== 'number') {
          reject(error ?? new Error(`${program} failed`));
          return;
        }
        resolve({ code, output: `${stdout}${stderr}` });
      },
    );
  });

export interface WindowsServiceControlOptions {
  readonly run?: RunCommand;
  readonly systemRoot?: string;
  /** How long `restart` waits for the service to stop before ending its processes. */
  readonly stopWaitMs?: number;
  readonly pollMs?: number;
}

export class WindowsServiceControl implements ServiceControl {
  private readonly run: RunCommand;
  private readonly sc: string;
  private readonly taskkill: string;

  constructor(private readonly options: WindowsServiceControlOptions = {}) {
    this.run = options.run ?? runCommand;
    const system32 = join(
      options.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
    );
    this.sc = join(system32, 'sc.exe');
    this.taskkill = join(system32, 'taskkill.exe');
  }

  async state(name: string): Promise<ServiceState> {
    const { code, output } = await this.run(this.sc, ['query', name]);
    if (code === NOT_INSTALLED) return 'MISSING';
    if (code !== 0) throw new Error(`sc query ${name} failed (${String(code)}): ${output.trim()}`);
    return parseScState(output);
  }

  async start(name: string): Promise<void> {
    const { code, output } = await this.run(this.sc, ['start', name]);
    if (code !== 0 && code !== ALREADY_RUNNING) {
      throw new Error(`sc start ${name} failed (${String(code)}): ${output.trim()}`);
    }
  }

  async restart(name: string): Promise<void> {
    const { code } = await this.run(this.sc, ['stop', name]);
    // A service stuck starting refuses to be stopped (1061): it is ended below instead.
    const stopping = code === 0 || code === NOT_ACTIVE;
    if (!stopping || !(await this.waitFor(name, 'STOPPED', this.options.stopWaitMs ?? 20_000))) {
      // It will not stop: end the wrapper and everything it started.
      const queried = await this.run(this.sc, ['queryex', name]);
      const pid = parseScPid(queried.output);
      if (pid !== null) {
        await this.run(this.taskkill, ['/F', '/T', '/PID', String(pid)]);
      }
      if (!(await this.waitFor(name, 'STOPPED', 10_000))) {
        throw new Error(`${name} did not stop`);
      }
    }
    await this.start(name);
  }

  private async waitFor(name: string, wanted: ServiceState, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    for (;;) {
      if ((await this.state(name)) === wanted) return true;
      if (Date.now() >= until) return false;
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 500));
    }
  }
}
