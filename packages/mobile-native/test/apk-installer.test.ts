import type { ApkInstallResult } from '@rp/mobile-core';
import { describe, expect, it } from 'vitest';
import { AndroidApkInstaller, type ApkInstallerNative, installResultOf } from '../src/index.js';

/** The native module's stand-in. */
function fakeNative(deviceOwner = false, versionName: string | null = '1.4.2') {
  const calls: string[] = [];
  let emit: ((event: { kind: string; message?: string | null }) => void) | undefined;
  const native: ApkInstallerNative = {
    state: () => ({ versionName, deviceOwner }),
    mayRequestInstall: () => Promise.resolve(false),
    openInstallSettings: () => {
      calls.push('settings');
      return Promise.resolve();
    },
    download: (url, headers, sha256, sizeBytes, version) => {
      calls.push(
        `download ${url} ${headers['x-device-token'] ?? ''} ${sha256} ${String(sizeBytes)} ${version}`,
      );
      return Promise.resolve('/cache/rp-apk/abc.apk');
    },
    install: (path) => {
      calls.push(`install ${path}`);
      return Promise.resolve();
    },
    addListener: (_name, listener) => {
      emit = listener;
      return {
        remove: () => {
          emit = undefined;
        },
      };
    },
  };
  return { native, calls, emit: (event: { kind: string; message?: string }) => emit?.(event) };
}

describe('[WTR-001] [UPD-007] Android’s PackageInstaller for the in-app updater', () => {
  it('downloads with the device’s credentials and the expected SHA-256, then installs', async () => {
    const { native, calls } = fakeNative();
    const installer = new AndroidApkInstaller(native);
    expect(installer.enabled).toBe(true);
    expect(installer.installedVersion).toBe('1.4.2');
    expect(installer.silent()).toBe(false);
    expect(await installer.mayRequestInstall()).toBe(false);
    await installer.openInstallSettings();
    const apk = await installer.download(
      { url: 'https://pos/apk', headers: { 'x-device-token': 't-1' } },
      { sha256: 'f'.repeat(64), sizeBytes: 1234, version: '1.5.0' },
    );
    await installer.install(apk);
    expect(calls).toEqual([
      'settings',
      `download https://pos/apk t-1 ${'f'.repeat(64)} 1234 1.5.0`,
      'install /cache/rp-apk/abc.apk',
    ]);
  });

  it('[TAB-001] installs without asking as the tablet’s device owner', () => {
    const installer = new AndroidApkInstaller(fakeNative(true, null).native);
    expect(installer.silent()).toBe(true);
    expect(installer.installedVersion).toBeUndefined();
  });

  it('passes on Android’s answer until it stops listening', () => {
    const fake = fakeNative();
    const results: ApkInstallResult[] = [];
    const stop = new AndroidApkInstaller(fake.native).onResult((result) => results.push(result));
    fake.emit({ kind: 'cancelled' });
    fake.emit({ kind: 'failed', message: 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' });
    stop();
    fake.emit({ kind: 'cancelled' });
    expect(results).toEqual([
      { kind: 'cancelled' },
      { kind: 'failed', message: 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' },
    ]);
    expect(installResultOf({ kind: 'failed', message: null })).toEqual({
      kind: 'failed',
      message: 'unknown',
    });
  });
});
