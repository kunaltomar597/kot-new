import type { KeyObject } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ApiClient, type ConnectionStatus, type RealtimeConnection } from '@rp/api-client';
import type { DomainEvent } from '@rp/contracts';
import { type LiveRefresh, liveRefresh } from '@rp/ordering';
import { io } from 'socket.io-client';
import { signAsDevice } from '../helpers/auth-kit.js';
import type { SampleSets } from './stats.js';
import { tlsFetch } from './tls-fetch.js';

/** What a simulated device is. */
export type SimulatedKind =
  'TABLET' | 'WAITER_PHONE' | 'KDS' | 'POS' | 'DASHBOARD' | 'SPARE_SCREEN';

const APP: Readonly<Record<SimulatedKind, string>> = {
  TABLET: 'table-tablet',
  WAITER_PHONE: 'waiter-app',
  KDS: 'console',
  POS: 'console',
  DASHBOARD: 'console',
  SPARE_SCREEN: 'console',
};

/** Requests, errors and what the server refused, shared by every device of a run. */
export interface DeviceMetrics {
  /** Latency of every REST call, by operation. */
  readonly http: SampleSets;
  /** Failed calls by operation and code, e.g. `submitOrder 409 TABLE_BUSY`. */
  readonly errors: Map<string, number>;
}

export function countError(metrics: DeviceMetrics, key: string): void {
  metrics.errors.set(key, (metrics.errors.get(key) ?? 0) + 1);
}

function errorKey(operation: string, error: unknown): string {
  const status = (error as { status?: unknown }).status;
  const code = (error as { code?: unknown }).code;
  const name = error instanceof Error ? error.name : 'Error';
  return `${operation} ${typeof status === 'number' ? String(status) : name} ${typeof code === 'string' ? code : ''}`.trim();
}

export interface DeviceIdentity {
  readonly kind: SimulatedKind;
  readonly deviceId: string;
  readonly privateKey: KeyObject;
  /** The person signed in on it (with their PIN), if any. */
  readonly person?: { readonly staffId: string; readonly pin: string };
  /** A device token it already has; without one it signs a challenge for one. */
  readonly token?: { readonly value: string; readonly expiresAt: string };
}

/**
 * A paired phone, tablet, kitchen screen, POS or dashboard (P8-01a): the apps' own REST client
 * over HTTPS pinned to the restaurant's CA, its live connection, and the screens it shows, read
 * again after the events that change them and after a reconnect, as the apps' `useLive` does.
 * Every call is timed.
 */
export class SimulatedDevice {
  readonly client: ApiClient;
  /** When the live connection was in sync again, each time. */
  readonly syncedAt: number[] = [];
  status: ConnectionStatus = 'stopped';
  private connection: RealtimeConnection | undefined;
  private readonly listeners: ((event: DomainEvent, at: number) => void)[] = [];
  private readonly resynced: (() => void)[] = [];
  private readonly refreshes: LiveRefresh[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();
  private stopped = false;
  /** Set when the server ended the person's session or the device; the run reports it. */
  ended: string | undefined;

  constructor(
    readonly identity: DeviceIdentity,
    baseUrl: string,
    private readonly ca: string,
    private readonly metrics: DeviceMetrics,
  ) {
    this.client = new ApiClient({
      baseUrl,
      fetch: tlsFetch(ca),
      client: { kind: APP[identity.kind], version: '1.0.0' },
      credentials: {
        device: {
          deviceId: identity.deviceId,
          ...(identity.token !== undefined && {
            deviceToken: identity.token.value,
            deviceTokenExpiresAt: identity.token.expiresAt,
          }),
        },
      },
      signer: {
        algorithm: 'Ed25519',
        sign: (message) => Promise.resolve(signAsDevice(identity.privateKey, message)),
      },
      timeoutMs: 30_000,
      onSessionEnded: (code) => {
        this.ended ??= `session ${code}`;
      },
      onDeviceRevoked: () => {
        this.ended ??= 'device revoked';
      },
    });
  }

  get kind(): SimulatedKind {
    return this.identity.kind;
  }

  get api(): ApiClient['api'] {
    return this.client.api;
  }

  /** Gets a device token if it has none, and signs the person in. */
  async start(): Promise<void> {
    await this.client.deviceToken();
    const person = this.identity.person;
    if (person !== undefined) {
      await this.call('pinLogin', () =>
        this.client.signInWithPin({ staffId: person.staffId, pin: person.pin }),
      );
    }
  }

  /** Opens the live connection; resolves once it is in sync. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`${this.kind} ${this.identity.deviceId} did not connect`));
      }, 30_000);
      this.connection = this.client.connectRealtime({
        connect: (url, options) => io(url, { ...options, ca: this.ca }),
        onEvent: (event) => {
          const at = performance.now();
          for (const listener of this.listeners) listener(event, at);
        },
        onSync: () => {
          this.syncedAt.push(performance.now());
          clearTimeout(timeout);
          resolve();
          if (this.syncedAt.length > 1) for (const listener of this.resynced) listener();
        },
        onStatus: (status) => {
          this.status = status;
        },
        onEnded: (reason) => {
          this.ended ??= `connection ${reason}`;
        },
      });
      this.connection.start();
    });
  }

  onEvent(listener: (event: DomainEvent, at: number) => void): void {
    this.listeners.push(listener);
  }

  /** Times a call under its operation's name and counts its failure; rethrows it. */
  async call<T>(operation: string, run: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      const value = await run();
      this.metrics.http.of(operation).add(performance.now() - started);
      return value;
    } catch (error) {
      countError(this.metrics, errorKey(operation, error));
      throw error;
    }
  }

  /**
   * A screen that shows `load`'s answer: read now, again after the events `affects` (as the
   * apps' `useLive`, with `liveRefresh`) and after the connection comes back. Stale answers are
   * dropped; `show` gets each fresh one.
   */
  screen<T>(
    operation: string,
    affects: (eventType: string) => boolean,
    load: () => Promise<T>,
    show: (value: T, at: number) => void = () => undefined,
  ): void {
    let generation = 0;
    const read = () => {
      if (this.stopped) return;
      const current = ++generation;
      this.call(operation, load).then(
        (value) => {
          if (current === generation && !this.stopped) show(value, performance.now());
        },
        () => undefined,
      );
    };
    const refresh = liveRefresh(read);
    this.refreshes.push(refresh);
    this.onEvent((event) => {
      if (affects(event.type)) refresh.notify();
    });
    this.resynced.push(read);
    read();
  }

  /** Runs `action` after `ms` unless the device was stopped. */
  later(ms: number, action: () => Promise<unknown>): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.stopped) action().catch(() => undefined);
    }, ms);
    this.timers.add(timer);
  }

  stop(): void {
    this.stopped = true;
    for (const refresh of this.refreshes) refresh.cancel();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.connection?.stop();
  }
}
