import type { ApkInstaller, ApkInstallResult, DownloadedApk, ExpectedApk } from '@rp/mobile-core';

/** The native half (`RpApkInstallerModule.kt`, `ApkInstalls.kt`, the receivers). */
export interface ApkInstallerNative {
  state(): { versionName: string | null; deviceOwner: boolean };
  mayRequestInstall(): Promise<boolean>;
  openInstallSettings(): Promise<void>;
  download(
    url: string,
    headers: Record<string, string>,
    sha256: string,
    sizeBytes: number,
    version: string,
  ): Promise<string>;
  install(path: string): Promise<void>;
  addListener(
    eventName: 'onInstallResult',
    listener: (event: { kind: string; message?: string | null }) => void,
  ): { remove(): void };
}

/** Android's answer as the updater takes it: anything but "cancelled" is a refusal. */
export function installResultOf(event: {
  kind: string;
  message?: string | null;
}): ApkInstallResult {
  return event.kind === 'cancelled'
    ? { kind: 'cancelled' }
    : { kind: 'failed', message: event.message ?? 'unknown' };
}

/**
 * Android's `PackageInstaller` as `@rp/mobile-core`'s `ApkInstaller` (P7-04e2, WTR-001, UPD-007).
 * The APK is downloaded from the restaurant PC by the native HTTP client over the pinned LAN CA
 * with the device's token, kept only if its size, SHA-256, package and version are the expected
 * ones, then handed to Android, which installs it only over an app signed with the same key. A
 * device-owner tablet installs without asking; a phone shows Android's confirmation and needs
 * "Install unknown apps" for the app. Load it once with `AndroidApkInstaller.load()`.
 */
export class AndroidApkInstaller implements ApkInstaller {
  readonly enabled = true;

  constructor(private readonly native: ApkInstallerNative) {}

  static async load(): Promise<AndroidApkInstaller> {
    const { requireNativeModule } = await import('expo');
    return new AndroidApkInstaller(requireNativeModule<ApkInstallerNative>('RpApkInstaller'));
  }

  get installedVersion(): string | undefined {
    return this.native.state().versionName ?? undefined;
  }

  silent(): boolean {
    return this.native.state().deviceOwner;
  }

  mayRequestInstall(): Promise<boolean> {
    return this.native.mayRequestInstall();
  }

  openInstallSettings(): Promise<void> {
    return this.native.openInstallSettings();
  }

  async download(
    request: { readonly url: string; readonly headers: Record<string, string> },
    expected: ExpectedApk,
  ): Promise<DownloadedApk> {
    const path = await this.native.download(
      request.url,
      request.headers,
      expected.sha256,
      expected.sizeBytes,
      expected.version,
    );
    return { path };
  }

  install(apk: DownloadedApk): Promise<void> {
    return this.native.install(apk.path);
  }

  onResult(listener: (result: ApkInstallResult) => void): () => void {
    const subscription = this.native.addListener('onInstallResult', (event) => {
      listener(installResultOf(event));
    });
    return () => {
      subscription.remove();
    };
  }
}
