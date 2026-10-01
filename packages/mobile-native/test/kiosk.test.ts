import { describe, expect, it } from 'vitest';
import { AndroidKiosk, type KioskNative } from '../src/index.js';

/** The native module's stand-in: lock-task mode as Android keeps it. */
function fakeKiosk(health: ReturnType<KioskNative['health']>, deviceOwner = true) {
  let mode = 'NONE';
  const calls: string[] = [];
  const native: KioskNative = {
    state: () => ({ mode, deviceOwner, permitted: deviceOwner }),
    enter: () => {
      calls.push('enter');
      mode = deviceOwner ? 'LOCKED' : 'PINNED';
      return Promise.resolve(mode);
    },
    exit: () => {
      calls.push('exit');
      mode = 'NONE';
      return Promise.resolve(mode);
    },
    keepScreenOn: (on) => {
      calls.push(`screen ${String(on)}`);
      return Promise.resolve();
    },
    health: () => health,
    locateTone: (durationMs) => {
      calls.push(`tone ${String(durationMs)}`);
      return Promise.resolve();
    },
  };
  return { native, calls };
}

describe('[TAB-001] the kiosk on Android', () => {
  it('locks as device owner and pins otherwise, and lets go after the PIN', async () => {
    const owner = fakeKiosk({ batteryPercent: 50, charging: true, network: 'WIFI', rssi: -50 });
    const kiosk = new AndroidKiosk(owner.native);
    expect(kiosk.state()).toEqual({ mode: 'NONE', deviceOwner: true, permitted: true });
    expect(await kiosk.enter()).toBe('LOCKED');
    expect(await kiosk.exit()).toBe('NONE');
    const pinned = new AndroidKiosk(
      fakeKiosk({ batteryPercent: 50, charging: true, network: 'WIFI', rssi: -50 }, false).native,
    );
    expect(await pinned.enter()).toBe('PINNED');
  });
});

describe('[TAB-015] the device’s health', () => {
  it('passes on what the server takes', () => {
    const kiosk = new AndroidKiosk(
      fakeKiosk({ batteryPercent: 18, charging: false, network: 'WIFI', rssi: -61 }).native,
    );
    expect(kiosk.readHealth()).toEqual({
      batteryPercent: 18,
      charging: false,
      network: 'WIFI',
      rssi: -61,
    });
  });

  it('reads anything odd as unknown', () => {
    const kiosk = new AndroidKiosk(
      fakeKiosk({ batteryPercent: 140, charging: null, network: 'BLUETOOTH', rssi: 12 }).native,
    );
    expect(kiosk.readHealth()).toEqual({
      batteryPercent: null,
      charging: null,
      network: 'OTHER',
      rssi: null,
    });
  });
});
