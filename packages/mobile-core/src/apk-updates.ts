import type { TypedApi } from '@rp/api-client';
import type { AppBuildView } from '@rp/contracts';
import { apkUpdateVerdict, mayInstallApkUnattended } from '@rp/domain';
import { OTA_CHECK_INTERVAL_MS } from './app-updates.js';
import type { DeviceSessionSnapshot } from './device-session.js';

/** A downloaded APK, checked on the device before Android sees it. */
export interface DownloadedApk {
  /** Where it is, in the app's own cache. */
  readonly path: string;
}

/** What the APK must be: the PC's description of it (`getCurrentAppBuild`). */
export interface ExpectedApk {
  readonly sha256: string;
  readonly sizeBytes: number;
  /** The app version it must carry (Android's `versionName`). */
  readonly version: string;
}

/**
 * Android's answer when an install did not happen. A successful one replaces the app, which stops
 * it; the new app starts afresh.
 */
export type ApkInstallResult =
  /** The person said no on Android's confirmation. */
  | { readonly kind: 'cancelled' }
  /** Android refused it, e.g. signed with another key, or not enough space. */
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Android's `PackageInstaller` (`@rp/mobile-native`'s `AndroidApkInstaller`; a fake in tests).
 */
export interface ApkInstaller {
  /** False where nothing can be installed (development tools, tests without one). */
  readonly enabled: boolean;
  /** The version of the app installed (Android's `versionName`), if known. */
  readonly installedVersion: string | undefined;
  /** Whether Android installs without asking anyone: the app owns its device (a kiosk tablet). */
  silent(): boolean;
  /** Whether Android lets this app ask to install updates ("Install unknown apps" for it). */
  mayRequestInstall(): Promise<boolean>;
  /** Opens Android's page where a person lets this app install updates. */
  openInstallSettings(): Promise<void>;
  /**
   * Downloads the APK with these credentials over the pinned LAN CA, and checks it: its size and
   * SHA-256, and that it is this same app at the expected version. Rejects otherwise, deleting it.
   */
  download(
    request: { readonly url: string; readonly headers: Record<string, string> },
    expected: ExpectedApk,
  ): Promise<DownloadedApk>;
  /**
   * Hands the APK to Android. Resolves once handed over: a phone then shows Android's own
   * confirmation; Android refuses an APK signed with another key than the app's (UPD-007).
   */
  install(apk: DownloadedApk): Promise<void>;
  /** Android's answer when an install did not happen. */
  onResult(listener: (result: ApkInstallResult) => void): () => void;
}

/**
 * - `off`: nothing can be installed here;
 * - `idle`: up to date, or not checked yet;
 * - `checking`;
 * - `available`: the PC has a newer build of this app; a person presses Install (a phone), or a
 *   kiosk tablet installs it when free;
 * - `needsPermission`: Android does not let this app install updates yet; a person allows it;
 * - `downloading`, `installing` (with Android now: it asks the person on a phone);
 * - `failed`: see `failure`; offered again at the next check.
 */
export type ApkStatus =
  | 'off'
  | 'idle'
  | 'checking'
  | 'available'
  | 'needsPermission'
  | 'downloading'
  | 'installing'
  | 'failed';

/**
 * Why it failed: `check` (the PC could not be asked), `download` (or its check), `cancelled` (the
 * person said no) or `refused` (Android refused the APK).
 */
export type ApkFailure = 'check' | 'download' | 'cancelled' | 'refused';

export interface ApkSnapshot {
  readonly status: ApkStatus;
  /** The newer build on the PC, while one is offered. */
  readonly build: AppBuildView | null;
  readonly failure: ApkFailure | null;
  readonly checkedAt: Date | null;
}

/** What the updater reads of the device session. */
export interface ApkSession {
  readonly api: TypedApi;
  downloadRequest(
    operationId: 'downloadCurrentAppBuild',
  ): Promise<{ readonly url: string; headers: Record<string, string> }>;
  subscribe(listener: () => void): () => void;
  getSnapshot(): Pick<DeviceSessionSnapshot, 'phase' | 'connection' | 'clientTooOld'>;
}

export interface ApkUpdaterOptions {
  readonly session: ApkSession;
  readonly installer: ApkInstaller;
  /** How often to ask the PC besides each reconnect; 30 minutes by default. */
  readonly intervalMs?: number;
  readonly now?: () => Date;
  /** Where failures go: the device's error reporting (NFR-O02). */
  readonly onError?: (error: unknown) => void;
}

const INITIAL: ApkSnapshot = { status: 'idle', build: null, failure: null, checkedAt: null };

/** States in which a new check would get in the way. */
const BUSY: ReadonlySet<ApkStatus> = new Set(['checking', 'downloading', 'installing']);

/**
 * New APKs of the waiter app and the table tablet from the restaurant PC (WTR-001, UPD-001,
 * UPD-007, P7-04e2). The PC serves the builds of its own release. The device asks for its app's
 * build when it connects, when the server refuses it, and every 30 minutes, and offers one newer
 * than itself (`apkUpdateVerdict`):
 * - a phone shows the offer on the sign-in screen and on "Update this app", and a person presses
 *   Install; Android then asks them to confirm;
 * - a table tablet that owns its device (MDM) installs by itself between guests, or at once when
 *   refused; one that does not shows the offer to staff.
 *
 * The APK is downloaded from the PC with the device's credentials over the pinned CA and checked
 * against the PC's SHA-256 before Android sees it; Android installs it only over an app signed
 * with the same key.
 */
export class ApkUpdater {
  private snapshot: ApkSnapshot;
  private readonly listeners = new Set<() => void>();
  /** Until the app says otherwise, the device counts as in use. */
  private busy = true;
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private stopResults: (() => void) | undefined;
  private last: ReturnType<ApkSession['getSnapshot']> | undefined;

  constructor(private readonly options: ApkUpdaterOptions) {
    this.snapshot = options.installer.enabled ? INITIAL : { ...INITIAL, status: 'off' };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ApkSnapshot => this.snapshot;

  /** Whether Android installs without asking: the screens then have nothing to offer. */
  get silent(): boolean {
    return this.options.installer.enabled && this.options.installer.silent();
  }

  /** Follows the device session and asks the PC on its schedule. */
  start(): void {
    const { installer, session } = this.options;
    if (!installer.enabled || this.unsubscribe !== undefined) return;
    this.stopResults = installer.onResult((result) => {
      this.resultArrived(result);
    });
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
    this.stopResults?.();
    this.stopResults = undefined;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Whether someone is using the device; a kiosk tablet installs only while it is free. */
  setBusy(busy: boolean): void {
    this.busy = busy;
    this.installIfUnattended();
  }

  /** Asks the PC now; one check at a time. */
  check(): Promise<void> {
    if (!this.options.installer.enabled) return Promise.resolve();
    this.running ??= this.runCheck().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /**
   * Downloads and installs the build on offer: a person pressed Install, or a kiosk tablet is
   * free. Asks for Android's permission first where the app lacks it.
   */
  async install(): Promise<void> {
    const { build } = this.snapshot;
    if (build === null || BUSY.has(this.snapshot.status)) return;
    const { installer, session } = this.options;
    try {
      if (!installer.silent() && !(await installer.mayRequestInstall())) {
        this.update({ status: 'needsPermission', failure: null });
        return;
      }
      this.update({ status: 'downloading', failure: null });
      const apk = await installer.download(
        await session.downloadRequest('downloadCurrentAppBuild'),
        {
          sha256: build.sha256,
          sizeBytes: build.sizeBytes,
          version: build.version,
        },
      );
      this.update({ status: 'installing' });
      await installer.install(apk);
    } catch (error) {
      this.update({ status: 'failed', failure: 'download' });
      this.options.onError?.(error);
    }
  }

  /** Opens Android's page where a person lets this app install updates. */
  openInstallSettings(): Promise<void> {
    return this.options.installer.openInstallSettings();
  }

  private sessionChanged(): void {
    const now = this.options.session.getSnapshot();
    const before = this.last;
    this.last = now;
    // The PC may have been updated while the device was away; a refused app needs a new build.
    const cameOnline = now.connection === 'online' && before?.connection !== 'online';
    const refused = now.clientTooOld && before?.clientTooOld !== true;
    if (cameOnline || refused) void this.check();
    else this.installIfUnattended();
  }

  private async runCheck(): Promise<void> {
    const { session, installer } = this.options;
    if (session.getSnapshot().phase !== 'paired' || BUSY.has(this.snapshot.status)) return;
    const before = this.snapshot;
    this.update({ status: 'checking' });
    try {
      const { build } = await session.api.getCurrentAppBuild();
      const checkedAt = this.now();
      if (build === null) {
        this.update({ ...INITIAL, checkedAt });
        return;
      }
      const version = await session.api.getVersion();
      if (apkUpdateVerdict(version.clientApi, installer.installedVersion, build) !== 'OFFER') {
        this.update({ ...INITIAL, checkedAt });
        return;
      }
      // Waiting for the person to allow installs stays so until they try again.
      const status = before.status === 'needsPermission' ? 'needsPermission' : 'available';
      this.update({ status, build, failure: null, checkedAt });
      this.installIfUnattended();
    } catch (error) {
      this.update({ status: 'failed', failure: 'check' });
      this.options.onError?.(error);
    }
  }

  private resultArrived(result: ApkInstallResult): void {
    if (result.kind === 'cancelled') {
      this.update({ status: 'failed', failure: 'cancelled' });
      return;
    }
    this.update({ status: 'failed', failure: 'refused' });
    this.options.onError?.(
      new Error(`Android did not install the app’s update: ${result.message}`),
    );
  }

  private installIfUnattended(): void {
    if (this.snapshot.status !== 'available') return;
    const refused = this.options.session.getSnapshot().clientTooOld;
    const silent = this.options.installer.silent();
    if (!mayInstallApkUnattended({ silent, refused, busy: this.busy })) return;
    void this.install();
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private update(changes: Partial<ApkSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of this.listeners) listener();
  }
}
