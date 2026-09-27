import { describe, expect, it } from 'vitest';
import { AndroidServerTrust, type LanTrustNative } from '../src/index.js';

const SERVER = 'https://192.168.1.20:8443';
const CA = {
  certificate: '-----BEGIN CERTIFICATE-----\nTEFOIENB\n-----END CERTIFICATE-----\n',
  sha256: Array.from({ length: 32 }, () => 'AB').join(':'),
};

/** The native module's stand-in: one server hands out its CA; the pin lives in memory. */
function fakeLanTrust() {
  const state: { pinned: { certificate: string; serverUrl: string } | undefined } = {
    pinned: undefined,
  };
  const native: LanTrustNative = {
    fetchAuthority: (serverUrl) =>
      serverUrl === SERVER
        ? // The module also returns fields the app does not use.
          Promise.resolve({ ...CA, extra: 'ignored' } as typeof CA)
        : Promise.reject(
            Object.assign(new Error('The server did not answer'), { code: 'ERR_UNREACHABLE' }),
          ),
    pin: (certificate, serverUrl) => {
      state.pinned = { certificate, serverUrl };
      return Promise.resolve(CA.sha256);
    },
    pinned: () => Promise.resolve(state.pinned === undefined ? null : CA.sha256),
    clear: () => {
      state.pinned = undefined;
      return Promise.resolve();
    },
  };
  return { native, state };
}

describe('[SEC-010] the LAN CA pinned by the Android module (ADR-0011)', () => {
  it('downloads a server’s CA, pins it and forgets it on unpairing', async () => {
    const { native, state } = fakeLanTrust();
    const trust = new AndroidServerTrust(() => Promise.resolve(native));
    expect(await trust.pinned()).toBeUndefined();

    const authority = await trust.fetchAuthority(SERVER);
    expect(authority).toEqual(CA);
    await expect(trust.pin(authority.certificate, SERVER)).resolves.toBe(CA.sha256);
    expect(state.pinned).toEqual({ certificate: CA.certificate, serverUrl: SERVER });
    expect(await trust.pinned()).toBe(CA.sha256);

    await trust.clear();
    expect(state.pinned).toBeUndefined();
    expect(await trust.pinned()).toBeUndefined();
  });

  it('passes on the module’s error when a server does not answer', async () => {
    const { native } = fakeLanTrust();
    const trust = new AndroidServerTrust(() => Promise.resolve(native));
    await expect(trust.fetchAuthority('https://10.0.0.5:8443')).rejects.toMatchObject({
      code: 'ERR_UNREACHABLE',
    });
  });
});
