import { ApiRequestError, type TypedApi } from '@rp/api-client';
import { type DeviceHealthRequest, type DomainEvent, TabletTableView } from '@rp/contracts';
import { type KeyValueStore, readJson } from './storage.js';

// ---------------------------------------------------------------- kiosk and health (native side)

/** NONE, LOCKED (full kiosk, as device owner) or PINNED (screen pinning, asked of the person). */
export type KioskMode = 'NONE' | 'LOCKED' | 'PINNED';

export interface KioskState {
  readonly mode: KioskMode;
  /** The app is device owner (MDM, or `dpm set-device-owner` in testing): it locks without asking. */
  readonly deviceOwner: boolean;
  /** Android allows this app to lock (device owner has listed it). */
  readonly permitted: boolean;
}

/**
 * The table tablet's lock-task mode and screen (TAB-001): `RpKioskModule.kt` on Android, a fake
 * in tests.
 */
export interface Kiosk {
  state(): KioskState;
  enter(): Promise<KioskMode>;
  exit(): Promise<KioskMode>;
  keepScreenOn(on: boolean): Promise<void>;
  /** "Locate" from the dashboard (MGR-006): a tone for a few seconds. */
  locateTone(durationMs: number): Promise<void>;
}

/** What the device can tell about itself right now (TAB-015). */
export type DeviceHealthReading = Omit<DeviceHealthRequest, 'appVersion'>;

export interface DeviceHealthSource {
  readHealth(): DeviceHealthReading;
}

// ---------------------------------------------------------------- health reports

export interface HealthReporterOptions {
  readonly source: DeviceHealthSource;
  readonly api: () => TypedApi;
  readonly appVersion?: string;
  /** How often the device looks at itself (default a minute). */
  readonly sampleMs?: number;
  /** Reported at least this often even when nothing changed (default five minutes). */
  readonly quietMs?: number;
  /** A battery change this large is reported at once (default 5 points). */
  readonly batteryStep?: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

/**
 * Sends the device's health to the server (TAB-015): when it starts, when charging or the kind of
 * network changes, when the battery moves by a step, and every few minutes otherwise, so the
 * dashboard is current and a low battery alerts the managers. A report that fails is tried again
 * at the next look.
 */
export class HealthReporter {
  private timer: ReturnType<typeof setInterval> | undefined;
  private last: { reading: DeviceHealthReading; at: number } | undefined;
  private sending = false;

  constructor(private readonly options: HealthReporterOptions) {}

  start(): void {
    if (this.timer !== undefined) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.sampleMs ?? 60_000);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Looks now, e.g. when the connection comes back; reports when something changed. */
  async tick(force = false): Promise<void> {
    if (this.sending) return;
    let reading: DeviceHealthReading;
    try {
      reading = this.options.source.readHealth();
    } catch (error) {
      this.options.onError?.(error);
      return;
    }
    const now = (this.options.now ?? Date.now)();
    if (!force && !this.due(reading, now)) return;
    this.sending = true;
    try {
      await this.options.api().reportDeviceHealth({
        body: {
          ...reading,
          ...(this.options.appVersion !== undefined && { appVersion: this.options.appVersion }),
        },
      });
      this.last = { reading, at: now };
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.sending = false;
    }
  }

  private due(reading: DeviceHealthReading, now: number): boolean {
    const last = this.last;
    if (last === undefined) return true;
    if (now - last.at >= (this.options.quietMs ?? 300_000)) return true;
    if (reading.charging !== last.reading.charging) return true;
    if (reading.network !== last.reading.network) return true;
    const before = last.reading.batteryPercent;
    const after = reading.batteryPercent;
    if (before === null || after === null) return before !== after;
    return Math.abs(after - before) >= (this.options.batteryStep ?? 5);
  }
}

// ---------------------------------------------------------------- the table and its guests

/**
 * Where a tablet keeps what belongs to the guests at its table (TAB-003): the cart, their orders
 * and their feedback (P3-03, P5). All of it is wiped when the table's session closes or another
 * one begins.
 */
export const TABLET_GUEST_KEYS = [
  'rp.tablet.cart.v1',
  'rp.tablet.orders.v1',
  'rp.tablet.feedback.v1',
] as const;

const SESSION_KEY = 'rp.tablet.session.v1';
/** The table as last read, shown at once after a restart, before the server answers. */
const TABLE_KEY = 'rp.tablet.table.v1';

/** Events that change whether a table's session is open. */
const TABLE_EVENTS = new Set([
  'TableOpened',
  'TableClosed',
  'TableStateChanged',
  'TableMoved',
  'OrdersMoved',
  'TableWaiterChanged',
]);

export interface TabletSessionSnapshot {
  /**
   * `loading` until the table is read once; `unbound` when no manager has chosen its table;
   * `ready` with the table (and its session, if open); `error` when it could not be read and
   * nothing is known yet.
   */
  readonly status: 'loading' | 'ready' | 'unbound' | 'error';
  readonly table: TabletTableView | undefined;
  /** Bumped at each wipe, so screens holding guest data in memory start afresh. */
  readonly guestEpoch: number;
}

export interface TabletSessionOptions {
  readonly store: KeyValueStore;
  readonly api: () => TypedApi;
  readonly onError?: (error: unknown) => void;
}

/**
 * The tablet's table and its session (TAB-002, TAB-003): the idle screen while the table is free,
 * unlocked while a session is open. When the session closes, or a different one is found (the
 * tablet was off in between), everything the guests left on the device is wiped first: the stored
 * cart, orders and feedback, and whatever screens hold (`guestEpoch`).
 */
export class TabletSession {
  private snapshot: TabletSessionSnapshot = {
    status: 'loading',
    table: undefined,
    guestEpoch: 0,
  };
  private readonly listeners = new Set<() => void>();
  private reading: Promise<void> | undefined;
  private again = false;

  constructor(private readonly options: TabletSessionOptions) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): TabletSessionSnapshot => this.snapshot;

  /**
   * Shows the table as last read, if nothing newer is known yet: a tablet restarted while the
   * server is out of reach keeps its screen (NFR-A01).
   */
  async restore(): Promise<void> {
    const table = await readJson(this.options.store, TABLE_KEY, (value) =>
      TabletTableView.parse(value),
    );
    if (table !== null && this.snapshot.status === 'loading') {
      this.update({ status: 'ready', table });
    }
  }

  /** Reads the table again; a read asked for while one runs follows it. */
  refresh(): Promise<void> {
    if (this.reading !== undefined) {
      this.again = true;
      return this.reading;
    }
    this.reading = this.read().finally(() => {
      this.reading = undefined;
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.reading;
  }

  /** Live events: anything that may open, close or move the table's session reads it again. */
  handleEvent(event: DomainEvent): void {
    if (TABLE_EVENTS.has(event.type)) void this.refresh();
  }

  private async read(): Promise<void> {
    let table: TabletTableView;
    try {
      table = await this.options.api().getTabletTable();
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'TABLET_NOT_BOUND') {
        await this.settle(null);
        await this.options.store.removeItem(TABLE_KEY);
        this.update({ status: 'unbound', table: undefined });
        return;
      }
      this.options.onError?.(error);
      if (this.snapshot.status === 'loading') this.update({ status: 'error' });
      return;
    }
    await this.settle(table.session?.id ?? null);
    await this.options.store.setItem(TABLE_KEY, JSON.stringify(table));
    this.update({ status: 'ready', table });
  }

  /** Wipes the guests' data unless it belongs to the session now open. */
  private async settle(sessionId: string | null): Promise<void> {
    const { store } = this.options;
    const stored = await store.getItem(SESSION_KEY);
    if (stored === (sessionId ?? '')) return;
    for (const key of TABLET_GUEST_KEYS) await store.removeItem(key);
    await store.setItem(SESSION_KEY, sessionId ?? '');
    this.update({ guestEpoch: this.snapshot.guestEpoch + 1 });
  }

  private update(changes: Partial<TabletSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of this.listeners) listener();
  }
}
