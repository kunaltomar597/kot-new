import { ApiRequestError, type TypedApi } from '@rp/api-client';
import type { AlertView, DeviceAlertsResponse, DomainEvent } from '@rp/contracts';

/** The person a waiter phone alerts: who last signed in on it (P2-06a). */
export type AlertHolder = NonNullable<DeviceAlertsResponse['holder']>;

export interface AlertCenterSnapshot {
  /** `idle` until the first read; `error` when that read failed (later failures keep the list). */
  readonly status: 'idle' | 'ready' | 'error';
  readonly holder: AlertHolder | null;
  /** The holder's open alerts on the pager and app channels, oldest first. */
  readonly alerts: readonly AlertView[];
}

/**
 * Where alerts go besides the screen: on Android, a foreground service that keeps the phone
 * listening with the screen off, and a notification per alert (P2-06b, WTR-005).
 */
export interface AlertNotifier {
  /** The phone holds a person: keep listening for their alerts until `stop`. */
  start(holder: AlertHolder): Promise<void>;
  /** Nobody to alert any more: the person signed out, or holds another phone now. */
  stop(): Promise<void>;
  /** An alert that is new here or came back (a repeat): show it, ring and vibrate. */
  announce(alert: AlertView): Promise<void>;
  /** The alert was acknowledged or cleared, anywhere. */
  dismiss(alertId: string): Promise<void>;
  /** Acknowledge pressed on a notification. Returns how to stop listening. */
  onAcknowledge(listener: (alertId: string) => void): () => void;
}

export interface AlertCenterOptions {
  readonly api: () => TypedApi;
  readonly notifier?: AlertNotifier;
  /** Where failures in the background (a read, the notifier) are reported. */
  readonly onError?: (error: unknown) => void;
}

const IDLE: AlertCenterSnapshot = { status: 'idle', holder: null, alerts: [] };

/**
 * The alerts of the person this waiter phone alerts, as their pager shows them (P2-06a, WTR-006):
 * read when the connection comes up or back (NTF-006), and again after an alert event for them.
 * Each alert and each repeat is announced once; acknowledging here acknowledges everywhere,
 * the pager included (NTF-004). The phone keeps its holder after an inactivity sign-out, so this
 * goes on while the person must sign in again for anything else (AUTH-005).
 */
export class AlertCenter {
  private snapshot: AlertCenterSnapshot = IDLE;
  private readonly listeners = new Set<() => void>();
  /** The repeat each open alert was last announced at. */
  private readonly announced = new Map<string, number>();
  private reading: Promise<void> | undefined;
  private readingAgain: Promise<void> | undefined;
  /** Bumped by `reset`, so a read that was on its way when the phone was unpaired is dropped. */
  private generation = 0;

  constructor(private readonly options: AlertCenterOptions) {
    options.notifier?.onAcknowledge((alertId) => {
      this.acknowledge(alertId).catch((error: unknown) => this.options.onError?.(error));
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): AlertCenterSnapshot => this.snapshot;

  /**
   * Reads the phone's alerts. While a read is on its way, one more follows it, shared by every
   * caller meanwhile, so nothing raised during a read is missed.
   */
  refresh(): Promise<void> {
    if (this.reading === undefined) {
      this.reading = this.read().finally(() => {
        this.reading = undefined;
      });
      return this.reading;
    }
    this.readingAgain ??= this.reading.then(() => {
      this.readingAgain = undefined;
      return this.refresh();
    });
    return this.readingAgain;
  }

  /** A live event: a new alert or a repeat for the holder, or one acknowledged or cleared. */
  handleEvent(event: DomainEvent): void {
    switch (event.type) {
      case 'AlertRaised': {
        if (!this.mayConcernHolder(event.payload.recipients)) return;
        const known = this.snapshot.alerts.find((alert) => alert.id === event.payload.alertId);
        if (known !== undefined && event.payload.repeat > known.repeatCount) {
          // A repeat of an alert on the screen rings at once; the read brings the rest.
          const repeated = { ...known, repeatCount: event.payload.repeat };
          this.update({
            alerts: this.snapshot.alerts.map((alert) => (alert.id === known.id ? repeated : alert)),
          });
          this.announce(repeated);
        }
        void this.refresh();
        return;
      }
      case 'AlertAcknowledged':
      case 'AlertCleared':
        this.remove(event.payload.alertId);
        return;
      default:
        return;
    }
  }

  /**
   * Acknowledges as the holder, like the pager's button: the repeats and the escalation stop and
   * every device hears it (NTF-004). An alert already gone is simply taken off.
   */
  async acknowledge(alertId: string): Promise<void> {
    try {
      await this.options.api().acknowledgeDeviceAlert({ params: { alertId } });
    } catch (error) {
      if (!(error instanceof ApiRequestError && error.status === 404)) throw error;
    }
    this.remove(alertId);
  }

  /** The phone was unpaired, or paired again: nothing of before applies. */
  reset(): void {
    this.generation += 1;
    const had = this.snapshot;
    this.announced.clear();
    this.update(IDLE);
    for (const alert of had.alerts) this.notify((notifier) => notifier.dismiss(alert.id));
    if (had.holder !== null) this.notify((notifier) => notifier.stop());
  }

  /**
   * Managers hear every alert of the restaurant; only the holder's matter here. Until the first read
   * says who the holder is, any alert is worth a read. A phone nobody holds has none: a new holder
   * comes with a new connection (signing in reconnects), which reads again.
   */
  private mayConcernHolder(recipients: readonly string[]): boolean {
    if (this.snapshot.status !== 'ready') return true;
    const holder = this.snapshot.holder;
    return holder !== null && recipients.includes(holder.staffId);
  }

  private async read(): Promise<void> {
    const generation = this.generation;
    let response: DeviceAlertsResponse;
    try {
      response = await this.options.api().listDeviceAlerts();
    } catch (error) {
      if (generation !== this.generation) return;
      this.options.onError?.(error);
      if (this.snapshot.status === 'idle') this.update({ status: 'error' });
      return;
    }
    if (generation === this.generation) this.apply(response);
  }

  private apply({ holder, alerts }: DeviceAlertsResponse): void {
    const before = this.snapshot;
    const samePerson = before.holder?.staffId === holder?.staffId;
    if (!samePerson) this.announced.clear();
    const open = new Set(alerts.map((alert) => alert.id));
    for (const alert of before.alerts) {
      if (!samePerson || !open.has(alert.id)) {
        this.announced.delete(alert.id);
        this.notify((notifier) => notifier.dismiss(alert.id));
      }
    }
    if (!samePerson || before.holder?.displayName !== holder?.displayName) {
      this.notify((notifier) => (holder === null ? notifier.stop() : notifier.start(holder)));
    }
    this.update({ status: 'ready', holder, alerts });
    for (const alert of alerts) this.announce(alert);
  }

  /** Rings for an alert new here, or come back since it last rang (NTF-006: once per repeat). */
  private announce(alert: AlertView): void {
    const last = this.announced.get(alert.id);
    if (last !== undefined && alert.repeatCount <= last) return;
    this.announced.set(alert.id, alert.repeatCount);
    this.notify((notifier) => notifier.announce(alert));
  }

  private remove(alertId: string): void {
    if (!this.snapshot.alerts.some((alert) => alert.id === alertId)) return;
    this.announced.delete(alertId);
    this.update({ alerts: this.snapshot.alerts.filter((alert) => alert.id !== alertId) });
    this.notify((notifier) => notifier.dismiss(alertId));
  }

  private notify(call: (notifier: AlertNotifier) => Promise<void>): void {
    const notifier = this.options.notifier;
    if (notifier === undefined) return;
    call(notifier).catch((error: unknown) => this.options.onError?.(error));
  }

  private update(changes: Partial<AlertCenterSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of this.listeners) listener();
  }
}
