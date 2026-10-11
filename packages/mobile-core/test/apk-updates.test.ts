import type { AppBuildView } from '@rp/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ApkInstaller,
  type ApkInstallResult,
  type ApkSession,
  ApkUpdater,
  type DownloadedApk,
  type ExpectedApk,
} from '../src/apk-updates.js';
import { OTA_CHECK_INTERVAL_MS } from '../src/app-updates.js';

type SessionState = ReturnType<ApkSession['getSnapshot']>;

const BUILD: AppBuildView = {
  kind: 'waiter-app',
  version: '1.5.0',
  clientApi: '1.4',
  sha256: 'b'.repeat(64),
  sizeBytes: 61_000_000,
};

/** The device session as the updater reads it: the PC's build of this app and its API range. */
function fakeSession() {
  const listeners = new Set<() => void>();
  let state: SessionState = { phase: 'paired', connection: 'connecting', clientTooOld: false };
  let build: AppBuildView | null = BUILD;
  let failing = false;
  const getCurrentAppBuild = vi.fn(() =>
    failing ? Promise.reject(new Error('offline')) : Promise.resolve({ build }),
  );
  const getVersion = vi.fn(() =>
    Promise.resolve({
      name: 'rp-server',
      version: '2.3.0',
      apiVersion: 'v1' as const,
      node: '24.12.0',
      clientApi: { current: '1.4', oldest: '1.3' },
    }),
  );
  const session: ApkSession = {
    api: { getCurrentAppBuild, getVersion } as unknown as ApkSession['api'],
    downloadRequest: () =>
      Promise.resolve({
        url: 'https://pos.test/api/v1/devices/current/app-build/apk',
        headers: { 'x-device-token': 'device-1' },
      }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
  };
  return {
    session,
    getCurrentAppBuild,
    set(changes: Partial<SessionState>) {
      state = { ...state, ...changes };
      for (const listener of listeners) listener();
    },
    setBuild(next: AppBuildView | null) {
      build = next;
    },
    setFailing(next: boolean) {
      failing = next;
    },
  };
}

/** Android's PackageInstaller as the app sees it. */
class FakeInstaller implements ApkInstaller {
  readonly calls: string[] = [];
  readonly downloads: { url: string; headers: Record<string, string>; expected: ExpectedApk }[] =
    [];
  allowed = true;
  owner = false;
  failDownload = false;
  private readonly listeners = new Set<(result: ApkInstallResult) => void>();

  installedVersion: string | undefined = '1.4.2';

  constructor(readonly enabled = true) {}

  silent(): boolean {
    return this.owner;
  }

  mayRequestInstall(): Promise<boolean> {
    this.calls.push('mayRequestInstall');
    return Promise.resolve(this.allowed);
  }

  openInstallSettings(): Promise<void> {
    this.calls.push('openInstallSettings');
    return Promise.resolve();
  }

  download(
    request: { url: string; headers: Record<string, string> },
    expected: ExpectedApk,
  ): Promise<DownloadedApk> {
    this.calls.push('download');
    this.downloads.push({ ...request, expected });
    return this.failDownload
      ? Promise.reject(new Error('The download does not match its SHA-256'))
      : Promise.resolve({ path: '/cache/rp-apk/b.apk' });
  }

  install(apk: DownloadedApk): Promise<void> {
    this.calls.push(`install ${apk.path}`);
    return Promise.resolve();
  }

  onResult(listener: (result: ApkInstallResult) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  answer(result: ApkInstallResult): void {
    for (const listener of this.listeners) listener(result);
  }

  get listening(): number {
    return this.listeners.size;
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

describe('[WTR-001] [UPD-001] a new APK from the restaurant PC (P7-04e2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers a newer build when the phone connects, and installs it when a person asks', async () => {
    const device = fakeSession();
    const installer = new FakeInstaller();
    const updater = new ApkUpdater({ session: device.session, installer });
    updater.start();
    device.set({ connection: 'online' });
    await settle();
    expect(updater.getSnapshot()).toMatchObject({ status: 'available', build: BUILD });
    expect(updater.silent).toBe(false);
    // A phone never installs by itself, even free.
    updater.setBusy(false);
    await settle();
    expect(installer.calls).toEqual([]);

    await updater.install();
    expect(installer.calls).toEqual([
      'mayRequestInstall',
      'download',
      'install /cache/rp-apk/b.apk',
    ]);
    expect(installer.downloads[0]).toEqual({
      url: 'https://pos.test/api/v1/devices/current/app-build/apk',
      headers: { 'x-device-token': 'device-1' },
      expected: { sha256: BUILD.sha256, sizeBytes: BUILD.sizeBytes, version: '1.5.0' },
    });
    expect(updater.getSnapshot().status).toBe('installing');
  });

  it('offers nothing when the PC has none, or the app is as new', async () => {
    const device = fakeSession();
    device.setBuild(null);
    const updater = new ApkUpdater({ session: device.session, installer: new FakeInstaller() });
    updater.start();
    device.set({ connection: 'online' });
    await settle();
    expect(updater.getSnapshot()).toMatchObject({ status: 'idle', build: null });

    device.setBuild(BUILD);
    const same = new ApkUpdater({
      session: device.session,
      installer: Object.assign(new FakeInstaller(), { installedVersion: '1.5.0' }),
    });
    await same.check();
    expect(same.getSnapshot()).toMatchObject({ status: 'idle', build: null });
    const unknown = new ApkUpdater({
      session: device.session,
      installer: Object.assign(new FakeInstaller(), { installedVersion: undefined }),
    });
    await unknown.check();
    expect(unknown.getSnapshot().status).toBe('idle');
    // Nothing is installed with no build on offer.
    await unknown.install();
    expect(unknown.getSnapshot().status).toBe('idle');
  });

  it('asks the person to allow installs first, then installs once they have', async () => {
    const device = fakeSession();
    const installer = new FakeInstaller();
    installer.allowed = false;
    const updater = new ApkUpdater({ session: device.session, installer });
    await updater.check();
    await updater.install();
    expect(updater.getSnapshot().status).toBe('needsPermission');
    await updater.openInstallSettings();
    expect(installer.calls).toEqual(['mayRequestInstall', 'openInstallSettings']);
    // A check meanwhile keeps the request.
    await updater.check();
    expect(updater.getSnapshot().status).toBe('needsPermission');
    installer.allowed = true;
    await updater.install();
    expect(updater.getSnapshot().status).toBe('installing');
  });

  it('[TAB-001] installs by itself on a kiosk tablet, but only between guests', async () => {
    const device = fakeSession();
    const installer = new FakeInstaller();
    installer.owner = true;
    const updater = new ApkUpdater({
      session: device.session,
      installer,
    });
    updater.start();
    device.set({ connection: 'online' });
    await settle();
    expect(updater.silent).toBe(true);
    expect(updater.getSnapshot().status).toBe('available');
    expect(installer.calls).toEqual([]);
    updater.setBusy(false);
    await settle();
    // No permission to ask for: the device owner installs without anyone.
    expect(installer.calls).toEqual(['download', 'install /cache/rp-apk/b.apk']);
  });

  it('[UPD-006] installs at once on a kiosk tablet the server refuses, guests or not', async () => {
    const device = fakeSession();
    const installer = new FakeInstaller();
    installer.owner = true;
    const updater = new ApkUpdater({ session: device.session, installer });
    updater.start();
    device.set({ connection: 'online', clientTooOld: true });
    await settle();
    expect(installer.calls).toContain('install /cache/rp-apk/b.apk');
  });

  it('[UPD-007] says when the download fails its check, and offers it again', async () => {
    const device = fakeSession();
    const installer = new FakeInstaller();
    installer.failDownload = true;
    const onError = vi.fn();
    const updater = new ApkUpdater({ session: device.session, installer, onError });
    await updater.check();
    await updater.install();
    expect(updater.getSnapshot()).toMatchObject({ status: 'failed', failure: 'download' });
    expect(onError).toHaveBeenCalledOnce();
    installer.failDownload = false;
    await updater.install();
    expect(updater.getSnapshot().status).toBe('installing');
  });

  it('hears Android’s answer: the person said no, or Android refused the APK', async () => {
    const device = fakeSession();
    const installer = new FakeInstaller();
    const onError = vi.fn();
    const updater = new ApkUpdater({ session: device.session, installer, onError });
    updater.start();
    await updater.check();
    await updater.install();
    installer.answer({ kind: 'cancelled' });
    expect(updater.getSnapshot()).toMatchObject({ status: 'failed', failure: 'cancelled' });
    expect(onError).not.toHaveBeenCalled();
    installer.answer({ kind: 'failed', message: 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' });
    expect(updater.getSnapshot()).toMatchObject({ status: 'failed', failure: 'refused' });
    expect(onError).toHaveBeenCalledOnce();
    // Still on offer: the person can try again.
    expect(updater.getSnapshot().build).toEqual(BUILD);
    updater.stop();
    expect(installer.listening).toBe(0);
  });

  it('asks the PC again every 30 minutes, and reports a failed check', async () => {
    const device = fakeSession();
    device.set({ connection: 'online' });
    const onError = vi.fn();
    const updater = new ApkUpdater({
      session: device.session,
      installer: new FakeInstaller(),
      onError,
    });
    updater.start();
    await settle();
    // Already online when it starts: it asks at once.
    expect(device.getCurrentAppBuild).toHaveBeenCalledTimes(1);
    device.setFailing(true);
    await vi.advanceTimersByTimeAsync(OTA_CHECK_INTERVAL_MS);
    expect(device.getCurrentAppBuild).toHaveBeenCalledTimes(2);
    expect(updater.getSnapshot()).toMatchObject({ status: 'failed', failure: 'check' });
    expect(onError).toHaveBeenCalledOnce();
    device.setFailing(false);
    await vi.advanceTimersByTimeAsync(OTA_CHECK_INTERVAL_MS);
    expect(updater.getSnapshot().status).toBe('available');
    updater.stop();
    await vi.advanceTimersByTimeAsync(OTA_CHECK_INTERVAL_MS);
    expect(device.getCurrentAppBuild).toHaveBeenCalledTimes(3);
  });

  it('does nothing where nothing can be installed, or before the device is paired', async () => {
    const device = fakeSession();
    const off = new ApkUpdater({ session: device.session, installer: new FakeInstaller(false) });
    off.start();
    await off.check();
    expect(off.getSnapshot().status).toBe('off');
    expect(off.silent).toBe(false);
    expect(device.getCurrentAppBuild).not.toHaveBeenCalled();

    device.set({ phase: 'unpaired' });
    const unpaired = new ApkUpdater({ session: device.session, installer: new FakeInstaller() });
    await unpaired.check();
    expect(unpaired.getSnapshot().status).toBe('idle');
    expect(device.getCurrentAppBuild).not.toHaveBeenCalled();
  });
});
