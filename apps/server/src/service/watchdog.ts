import type { ProbeResult } from './health-watch.js';
import type { HostState } from './host-state.js';
import type { HostLog } from './service-host.js';

/**
 * The watchdog service (NFR-A04, P0-16b): the second line behind the service host. The host keeps
 * the server process running; the watchdog keeps the services running:
 *
 * - the database or server service stopped (it crashed past Windows' own restarts, or someone
 *   stopped it): started again;
 * - the server service running but its host no longer writing its heartbeat (the host is stuck)
 *   while the server does not answer either, or the service stuck starting or stopping: stopped,
 *   ended if it will not stop, and started. A server that answers is never restarted (a full disk
 *   that stops the heartbeat must not take the restaurant's server down);
 * - nothing while the installer or the updater has the maintenance flag set.
 *
 * It never ends PostgreSQL: a database that is slow to start is recovering after a power cut.
 */

export const SERVICE_STATES = [
  'STOPPED',
  'START_PENDING',
  'STOP_PENDING',
  'RUNNING',
  'CONTINUE_PENDING',
  'PAUSE_PENDING',
  'PAUSED',
  /** Not installed. */
  'MISSING',
  /** Could not be asked. */
  'UNKNOWN',
] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

export type WatchedService = 'database' | 'server';

export interface WatchdogObservation {
  /** A monotonic clock in ms (not the wall clock, which may jump). */
  readonly at: number;
  readonly database: ServiceState;
  readonly server: ServiceState;
  /** The service host's state file, or null when there is none. */
  readonly host: HostState | null;
  /** The server answered its health check (200 or 503). */
  readonly serverAnswers: boolean;
  readonly maintenance: boolean;
}

export type WatchdogAction =
  | { readonly kind: 'start'; readonly service: WatchedService; readonly reason: string }
  | { readonly kind: 'restart'; readonly service: 'server'; readonly reason: string };

export interface WatchdogLimits {
  /** The host's heartbeat unchanged this long while its service runs: the host is stuck. */
  readonly hostStaleAfterMs: number;
  /** The server service starting or stopping this long: stuck. */
  readonly stuckPendingAfterMs: number;
  /** The same service is not acted on again sooner than this. */
  readonly cooldownMs: number;
}

export const DEFAULT_WATCHDOG_LIMITS: WatchdogLimits = {
  hostStaleAfterMs: 45_000,
  stuckPendingAfterMs: 120_000,
  cooldownMs: 30_000,
};

const PENDING: readonly ServiceState[] = ['START_PENDING', 'STOP_PENDING'];

/** Decides what to do from what it sees; remembers only times. */
export class WatchdogPolicy {
  private readonly limits: WatchdogLimits;
  private serverState: ServiceState | undefined;
  private serverStateSince = 0;
  private heartbeat: string | undefined;
  private heartbeatChangedAt = 0;
  private readonly lastAction = new Map<WatchedService, number>();

  constructor(limits: Partial<WatchdogLimits> = {}) {
    this.limits = { ...DEFAULT_WATCHDOG_LIMITS, ...limits };
  }

  decide(seen: WatchdogObservation): WatchdogAction[] {
    if (seen.server !== this.serverState) {
      this.serverState = seen.server;
      this.serverStateSince = seen.at;
    }
    const heartbeat = seen.host?.heartbeatAt;
    if (heartbeat !== this.heartbeat) {
      this.heartbeat = heartbeat;
      this.heartbeatChangedAt = seen.at;
    }
    if (seen.maintenance) return [];

    const actions: WatchdogAction[] = [];
    const ready = (service: WatchedService) =>
      seen.at - (this.lastAction.get(service) ?? -Infinity) >= this.limits.cooldownMs;
    const act = (action: WatchdogAction) => {
      if (!ready(action.service)) return;
      this.lastAction.set(action.service, seen.at);
      actions.push(action);
    };

    if (seen.database === 'STOPPED') {
      act({ kind: 'start', service: 'database', reason: 'the database service is stopped' });
    }
    const serverFor = seen.at - this.serverStateSince;
    if (seen.server === 'STOPPED') {
      // The server's service depends on the database's; Windows starts that first.
      act({ kind: 'start', service: 'server', reason: 'the server service is stopped' });
    } else if (PENDING.includes(seen.server) && serverFor >= this.limits.stuckPendingAfterMs) {
      act({
        kind: 'restart',
        service: 'server',
        reason: `the server service has been ${seen.server} for ${String(Math.round(serverFor / 1000))} s`,
      });
    } else if (
      seen.server === 'RUNNING' &&
      !seen.serverAnswers &&
      serverFor >= this.limits.hostStaleAfterMs
    ) {
      const silentFor = seen.at - this.heartbeatChangedAt;
      if (silentFor >= this.limits.hostStaleAfterMs) {
        act({
          kind: 'restart',
          service: 'server',
          reason:
            heartbeat === undefined
              ? 'the service host has written no state'
              : `the service host has been silent for ${String(Math.round(silentFor / 1000))} s`,
        });
      }
    }
    return actions;
  }
}

/** Windows' service manager, as the watchdog needs it. */
export interface ServiceControl {
  state(name: string): Promise<ServiceState>;
  start(name: string): Promise<void>;
  /** Stops it, ends its processes if it will not stop, and starts it again. */
  restart(name: string): Promise<void>;
}

export interface WatchdogOptions {
  readonly control: ServiceControl;
  readonly services: Readonly<Record<WatchedService, string>>;
  readHost(): Promise<HostState | null>;
  probe(): Promise<ProbeResult>;
  maintenance(): Promise<boolean>;
  readonly log: HostLog;
  readonly intervalMs?: number;
  readonly limits?: Partial<WatchdogLimits>;
  /** Monotonic ms. */
  readonly clock?: () => number;
}

export class Watchdog {
  private readonly policy: WatchdogPolicy;
  private readonly clock: () => number;
  private timer: NodeJS.Timeout | undefined;
  private checking: Promise<void> | undefined;
  private stopped = false;
  private reportedMissing = new Set<string>();

  constructor(private readonly options: WatchdogOptions) {
    this.policy = new WatchdogPolicy(options.limits);
    this.clock = options.clock ?? (() => performance.now());
  }

  /** One look and whatever it calls for; returns what was done. */
  async check(): Promise<WatchdogAction[]> {
    const { control, services, log } = this.options;
    const ask = async (name: string): Promise<ServiceState> => {
      try {
        return await control.state(name);
      } catch (error) {
        log('warn', 'Could not ask for a service', { service: name, error: String(error) });
        return 'UNKNOWN';
      }
    };
    const [database, server, host, probe, maintenance] = await Promise.all([
      ask(services.database),
      ask(services.server),
      this.options.readHost(),
      this.options.probe(),
      this.options.maintenance(),
    ]);
    for (const [service, state] of [
      [services.database, database],
      [services.server, server],
    ] as const) {
      if (state === 'MISSING' && !this.reportedMissing.has(service)) {
        this.reportedMissing.add(service);
        log('error', "A service is not installed; run the installer's repair", { service });
      } else if (state !== 'MISSING') {
        this.reportedMissing.delete(service);
      }
    }
    const actions = this.policy.decide({
      at: this.clock(),
      database,
      server,
      host,
      serverAnswers: probe !== 'unanswered',
      maintenance,
    });
    for (const action of actions) {
      const name = services[action.service];
      log('warn', action.kind === 'start' ? 'Starting a service' : 'Restarting a service', {
        service: name,
        reason: action.reason,
      });
      try {
        if (action.kind === 'start') await control.start(name);
        else await control.restart(name);
      } catch (error) {
        log('error', 'The service did not do as asked', {
          service: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return actions;
  }

  start(): void {
    const loop = () => {
      if (this.stopped) return;
      this.checking = this.check()
        .then(() => undefined)
        .catch((error: unknown) => {
          this.options.log('error', 'Watchdog check failed', { error: String(error) });
        })
        .finally(() => {
          if (!this.stopped) this.timer = setTimeout(loop, this.options.intervalMs ?? 5_000);
        });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.checking;
  }
}
