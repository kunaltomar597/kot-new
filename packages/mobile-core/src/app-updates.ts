import type { TypedApi } from '@rp/api-client';
import { mayApplyAppUpdate, type OtaVerdict, otaUpdateVerdict } from '@rp/domain';
import type { DeviceSessionSnapshot } from './device-session.js';

/** What a check for an over-the-air update found (EAS Update). */
export type OtaCheck =
  | { readonly kind: 'none' }
  /** A new update, with the client API it speaks (absent when it was published without it). */
  | { readonly kind: 'update'; readonly id: string; readonly clientApi: string | undefined }
  /** The vendor rolled the channel back to the JavaScript inside the APK. */
  | { readonly kind: 'rollback' };

/** What a download brought, judged again: the newest update may have changed since the check. */
export type OtaFetch =
  | { readonly kind: 'none' }
  | { readonly kind: 'update'; readonly id: string; readonly clientApi: string | undefined }
  | { readonly kind: 'rollback' };

/**
 * EAS Update on the device (`expo-updates` behind `@rp/mobile-native`'s `ExpoOtaUpdates`; a fake
 * in tests). The apps never check by themselves (`checkAutomatically: NEVER`): this decides.
 */
export interface OtaUpdateSource {
  /** False in development builds and builds without an EAS project: nothing to do. */
  readonly enabled: boolean;
  /**
   * Why the last launch fell back to the JavaScript inside the APK, when a downloaded update
   * failed to start (null otherwise). It is reported to the vendor.
   */
  readonly emergencyLaunchReason: string | null;
  check(): Promise<OtaCheck>;
  /**
   * Downloads the newest update. `expo-updates` refuses one whose code signature does not verify
   * against the certificate in the APK (UPD-007), which rejects this promise.
   */
  fetch(): Promise<OtaFetch>;
  /** Restarts the app's JavaScript on the downloaded update. */
  reload(): Promise<void>;
}

/**
 * - `off`: updates are off in this build;
 * - `idle`: up to date, or not checked yet;
 * - `checking`, `downloading`;
 * - `waiting`: an update speaks a newer client API than the server; it waits for the PC to update;
 * - `skipped`: an update the server no longer serves, or one without its client API;
 * - `ready`: downloaded, waiting until nobody is using the device;
 * - `applying`: the app is restarting on it;
 * - `failed`: the check or download failed; tried again at the next check.
 */
export type OtaStatus =
  | 'off'
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'waiting'
  | 'skipped'
  | 'ready'
  | 'applying'
  | 'failed';

export interface OtaSnapshot {
  readonly status: OtaStatus;
  /** Why an update found waits or was skipped. */
  readonly verdict: OtaVerdict | null;
  /** The update found or downloaded (null for none, or a rollback to the APK's JavaScript). */
  readonly updateId: string | null;
  /** The client API it speaks. */
  readonly clientApi: string | null;
  readonly checkedAt: Date | null;
}

/** What the updater reads of the device session. */
export interface OtaSession {
  readonly api: TypedApi;
  subscribe(listener: () => void): () => void;
  getSnapshot(): Pick<DeviceSessionSnapshot, 'phase' | 'connection' | 'clientTooOld'>;
}

export interface OtaUpdaterOptions {
  readonly session: OtaSession;
  readonly source: OtaUpdateSource;
  /** How often to look for an update besides each reconnect; 30 minutes by default. */
  readonly intervalMs?: number;
  readonly now?: () => Date;
  /** Where failures go: the device's error reporting (NFR-O02). */
  readonly onError?: (error: unknown) => void;
}

/** How often a device looks for an over-the-air update besides each reconnect. */
export const OTA_CHECK_INTERVAL_MS = 30 * 60_000;

const INITIAL: OtaSnapshot = {
  status: 'idle',
  verdict: null,
  updateId: null,
  clientApi: null,
  checkedAt: null,
};

/**
 * Over-the-air updates of the waiter app and the table tablet (UPD-001, UPD-006, P7-04e1). The
 * phone or tablet looks for an EAS update when it connects to the restaurant's server, when the
 * server refuses it, and every 30 minutes. It downloads one only when the server speaks the
 * update's client API (`otaUpdateVerdict`): an update made for a newer server waits until the PC
 * updates in its maintenance window. Once downloaded, the app restarts on it when nobody is using
 * the device (`setBusy`), or at once when the server refuses the app as it is.
 */
export class OtaUpdater {
  private snapshot: OtaSnapshot;
  private readonly listeners = new Set<() => void>();
  /** Until the app says otherwise, the device counts as in use. */
  private busy = true;
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private last: ReturnType<OtaSession['getSnapshot']> | undefined;

  constructor(private readonly options: OtaUpdaterOptions) {
    this.snapshot = options.source.enabled ? INITIAL : { ...INITIAL, status: 'off' };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): OtaSnapshot => this.snapshot;

  /** Follows the device session and checks on its schedule. */
  start(): void {
    const { source, session } = this.options;
    if (!source.enabled || this.unsubscribe !== undefined) return;
    if (source.emergencyLaunchReason !== null) {
      this.options.onError?.(
        new Error(
          `A downloaded update did not start; the app runs the one in its APK: ${source.emergencyLaunchReason}`,
        ),
      );
    }
    this.unsubscribe = session.subscribe(() => {
      this.sessionChanged();
    });
    this.timer = setInterval(() => {
      void this.check();
    }, this.options.intervalMs ?? OTA_CHECK_INTERVAL_MS);
    this.sessionChanged();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Whether someone is using the device: a person signed in on a waiter phone, guests at a
   * tablet's table, or the app off the screen. A downloaded update waits until it is free.
   */
  setBusy(busy: boolean): void {
    this.busy = busy;
    this.applyIfAllowed();
  }

  /** Looks for an update now; one check at a time. */
  check(): Promise<void> {
    if (!this.options.source.enabled) return Promise.resolve();
    this.running ??= this.runCheck().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private sessionChanged(): void {
    const now = this.options.session.getSnapshot();
    const before = this.last;
    this.last = now;
    // The server may have been updated while the device was away; a refused app needs one.
    const cameOnline = now.connection === 'online' && before?.connection !== 'online';
    const refused = now.clientTooOld && before?.clientTooOld !== true;
    if (cameOnline || refused) void this.check();
    else this.applyIfAllowed();
  }

  private async runCheck(): Promise<void> {
    const { session, source } = this.options;
    if (session.getSnapshot().phase !== 'paired') return; // No server to ask.
    if (this.snapshot.status === 'ready' || this.snapshot.status === 'applying') {
      this.applyIfAllowed();
      return;
    }
    this.update({ status: 'checking' });
    try {
      const found = await source.check();
      const checkedAt = this.now();
      if (found.kind === 'none') {
        this.update({ ...INITIAL, checkedAt });
        return;
      }
      const judged = await this.judge(found);
      this.update({ ...judged, checkedAt });
      if (judged.status !== 'downloading') return;
      const fetched = await source.fetch();
      if (fetched.kind === 'none') {
        this.update({ ...INITIAL, checkedAt });
        return;
      }
      // A newer update than the one checked may have been published in between: judge it again.
      const ready = await this.judge(fetched);
      this.update(ready.status === 'downloading' ? { ...ready, status: 'ready' } : ready);
      this.applyIfAllowed();
    } catch (error) {
      this.update({ status: 'failed' });
      this.options.onError?.(error);
    }
  }

  /** `downloading` when the server serves the update; a rollback is the vendor's own undo. */
  private async judge(
    found: Exclude<OtaCheck, { kind: 'none' }>,
  ): Promise<Pick<OtaSnapshot, 'status' | 'verdict' | 'updateId' | 'clientApi'>> {
    if (found.kind === 'rollback') {
      return { status: 'downloading', verdict: null, updateId: null, clientApi: null };
    }
    const version = await this.options.session.api.getVersion();
    const verdict = otaUpdateVerdict(version.clientApi, found.clientApi);
    const status =
      verdict === 'APPLY' ? 'downloading' : verdict === 'WAIT_FOR_SERVER' ? 'waiting' : 'skipped';
    return { status, verdict, updateId: found.id, clientApi: found.clientApi ?? null };
  }

  private applyIfAllowed(): void {
    if (this.snapshot.status !== 'ready') return;
    const refused = this.options.session.getSnapshot().clientTooOld;
    if (!mayApplyAppUpdate({ refused, busy: this.busy })) return;
    this.update({ status: 'applying' });
    this.options.source.reload().catch((error: unknown) => {
      // Tried again at the next check, which finds the downloaded update at once.
      this.update({ status: 'failed' });
      this.options.onError?.(error);
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private update(changes: Partial<OtaSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of this.listeners) listener();
  }
}
