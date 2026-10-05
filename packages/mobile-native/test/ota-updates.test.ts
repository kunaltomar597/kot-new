import { describe, expect, it, vi } from 'vitest';
import { clientApiOfManifest, ExpoOtaUpdates, type ExpoUpdatesModule } from '../src/index.js';

/** An EAS update's manifest as `expo-updates` gives it, with the app config it was published with. */
function manifest(id: string, clientApi?: unknown) {
  return {
    id,
    createdAt: '2026-10-05T03:00:00.000Z',
    runtimeVersion: '1.4.0',
    launchAsset: { url: 'https://u.expo.dev/bundle.js' },
    assets: [],
    metadata: {},
    extra: {
      expoClient: {
        name: 'RP Waiter',
        version: '1.4.0',
        extra: { appEnv: 'production', ...(clientApi !== undefined && { clientApi }) },
      },
    },
  };
}

function fakeUpdates(overrides: Partial<ExpoUpdatesModule> = {}): ExpoUpdatesModule {
  return {
    isEnabled: true,
    isEmergencyLaunch: false,
    emergencyLaunchReason: null,
    checkForUpdateAsync: () =>
      Promise.resolve({ isAvailable: false, isRollBackToEmbedded: false, manifest: undefined }),
    fetchUpdateAsync: () =>
      Promise.resolve({ isNew: false, isRollBackToEmbedded: false, manifest: undefined }),
    reloadAsync: () => Promise.resolve(),
    ...overrides,
  };
}

describe('[UPD-001] EAS Update through expo-updates', () => {
  it('reads the client API an update was published with', () => {
    expect(clientApiOfManifest(manifest('u-1', '1.4'))).toBe('1.4');
    expect(clientApiOfManifest(manifest('u-1'))).toBeUndefined();
    expect(clientApiOfManifest(manifest('u-1', 14))).toBeUndefined();
    expect(clientApiOfManifest(null)).toBeUndefined();
    expect(clientApiOfManifest({ extra: 'x' })).toBeUndefined();
  });

  it('says what a check found: an update with its API, a rollback, or nothing', async () => {
    const check = vi.fn<ExpoUpdatesModule['checkForUpdateAsync']>();
    const updates = new ExpoOtaUpdates(fakeUpdates({ checkForUpdateAsync: check }));
    check.mockResolvedValueOnce({
      isAvailable: true,
      isRollBackToEmbedded: false,
      manifest: manifest('u-1', '1.4'),
    });
    expect(await updates.check()).toEqual({ kind: 'update', id: 'u-1', clientApi: '1.4' });
    check.mockResolvedValueOnce({ isAvailable: false, isRollBackToEmbedded: true });
    expect(await updates.check()).toEqual({ kind: 'rollback' });
    check.mockResolvedValueOnce({ isAvailable: false, isRollBackToEmbedded: false });
    expect(await updates.check()).toEqual({ kind: 'none' });
    // A manifest without an id is not something to apply.
    check.mockResolvedValueOnce({ isAvailable: true, isRollBackToEmbedded: false, manifest: {} });
    expect(await updates.check()).toEqual({ kind: 'none' });
  });

  it('says what a download brought', async () => {
    const fetch = vi.fn<ExpoUpdatesModule['fetchUpdateAsync']>();
    const updates = new ExpoOtaUpdates(fakeUpdates({ fetchUpdateAsync: fetch }));
    fetch.mockResolvedValueOnce({
      isNew: true,
      isRollBackToEmbedded: false,
      manifest: manifest('u-2', '1.5'),
    });
    expect(await updates.fetch()).toEqual({ kind: 'update', id: 'u-2', clientApi: '1.5' });
    fetch.mockResolvedValueOnce({ isNew: false, isRollBackToEmbedded: true });
    expect(await updates.fetch()).toEqual({ kind: 'rollback' });
    fetch.mockResolvedValueOnce({ isNew: false, isRollBackToEmbedded: false });
    expect(await updates.fetch()).toEqual({ kind: 'none' });
  });

  it('[UPD-007] passes on a download refused for its code signature', async () => {
    const updates = new ExpoOtaUpdates(
      fakeUpdates({
        fetchUpdateAsync: () => Promise.reject(new Error('Code signature validation failed')),
      }),
    );
    await expect(updates.fetch()).rejects.toThrow('Code signature validation failed');
  });

  it('is off when expo-updates is, and says when an update failed to start', async () => {
    expect(new ExpoOtaUpdates(fakeUpdates({ isEnabled: false })).enabled).toBe(false);
    const normal = new ExpoOtaUpdates(fakeUpdates());
    expect(normal.enabled).toBe(true);
    expect(normal.emergencyLaunchReason).toBeNull();
    const fallen = new ExpoOtaUpdates(
      fakeUpdates({ isEmergencyLaunch: true, emergencyLaunchReason: 'bundle threw' }),
    );
    expect(fallen.emergencyLaunchReason).toBe('bundle threw');
    expect(new ExpoOtaUpdates(fakeUpdates({ isEmergencyLaunch: true })).emergencyLaunchReason).toBe(
      'unknown',
    );
    const reloadAsync = vi.fn(() => Promise.resolve());
    await new ExpoOtaUpdates(fakeUpdates({ reloadAsync })).reload();
    expect(reloadAsync).toHaveBeenCalledOnce();
  });

  it('loads expo-updates itself', async () => {
    vi.doMock('expo-updates', () => fakeUpdates({ isEnabled: false }));
    const updates = await ExpoOtaUpdates.load();
    expect(updates.enabled).toBe(false);
    vi.doUnmock('expo-updates');
  });
});
