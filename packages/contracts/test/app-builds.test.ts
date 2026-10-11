import { describe, expect, it } from 'vitest';
import {
  AppBuildsFile,
  CurrentAppBuildResponse,
  MAX_APK_BYTES,
  ROUTES,
  SystemAppBuild,
} from '../src/index.js';

const sha = 'a'.repeat(64);
const waiter = {
  kind: 'waiter-app',
  version: '1.4.0',
  clientApi: '1.0',
  file: 'waiter-app-1.4.0.apk',
  sha256: sha,
  sizeBytes: 61_000_000,
} as const;

describe('[WTR-001] the APKs a restaurant PC serves (P7-04e2)', () => {
  it('reads the packaging step’s apps.json', () => {
    const file = AppBuildsFile.parse({ format: 1, release: '2.3.0', apps: [waiter] });
    expect(file.apps[0]?.kind).toBe('waiter-app');
    expect(AppBuildsFile.parse({ format: 1, release: '2.3.0', apps: [] }).apps).toEqual([]);
  });

  it('refuses a file it cannot trust: unknown apps, paths, bad hashes, sizes, duplicates', () => {
    const bad = [
      { ...waiter, kind: 'console' },
      { ...waiter, file: '../server/dist/main.js' },
      { ...waiter, file: 'sub/waiter-app-1.4.0.apk' },
      { ...waiter, file: 'waiter-app-1.4.0.exe' },
      { ...waiter, sha256: sha.toUpperCase() },
      { ...waiter, sha256: 'a'.repeat(63) },
      { ...waiter, sizeBytes: 0 },
      { ...waiter, sizeBytes: MAX_APK_BYTES + 1 },
      { ...waiter, version: 'latest' },
      { ...waiter, clientApi: '1' },
      { ...waiter, extra: true },
    ];
    for (const app of bad) {
      expect(AppBuildsFile.safeParse({ format: 1, release: '2.3.0', apps: [app] }).success).toBe(
        false,
      );
    }
    expect(
      AppBuildsFile.safeParse({ format: 1, release: '2.3.0', apps: [waiter, waiter] }).success,
    ).toBe(false);
    expect(AppBuildsFile.safeParse({ format: 2, release: '2.3.0', apps: [] }).success).toBe(false);
  });

  it('describes a device’s build, or none, and each build’s state on the System page', () => {
    const { file: _file, ...view } = waiter;
    expect(CurrentAppBuildResponse.parse({ build: view }).build?.version).toBe('1.4.0');
    expect(CurrentAppBuildResponse.parse({ build: null }).build).toBeNull();
    expect(SystemAppBuild.parse({ ...view, status: 'DAMAGED' }).status).toBe('DAMAGED');
    expect(SystemAppBuild.safeParse({ ...view, status: 'BROKEN' }).success).toBe(false);
  });

  it('[UPD-006] serves the build to the paired device alone, no person needed', () => {
    for (const operationId of ['getCurrentAppBuild', 'downloadCurrentAppBuild']) {
      const route = ROUTES.find((entry) => entry.operationId === operationId);
      expect(route?.capability, operationId).toBe('DEVICE');
      expect(route?.path.startsWith('/api/v1/devices/current/app-build'), operationId).toBe(true);
    }
  });
});
