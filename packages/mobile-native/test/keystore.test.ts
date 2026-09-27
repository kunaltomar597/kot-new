import { createPublicKey, generateKeyPairSync, sign, webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  derToRawEcdsa,
  type DeviceKeyNative,
  fromBase64,
  KeystoreDeviceKeys,
} from '../src/index.js';

/** A stand-in for the Keystore: a Node P-256 key that signs in DER, as Android does. */
function fakeKeystore() {
  const keys = new Map<string, { publicKey: string; privateKey: string }>();
  const native: DeviceKeyNative = {
    publicKey: (alias) => {
      const pair = keys.get(alias);
      if (pair === undefined) return Promise.resolve(null);
      const der = createPublicKey(pair.publicKey).export({ type: 'spki', format: 'der' });
      return Promise.resolve(der.toString('base64'));
    },
    create: async (alias) => {
      keys.set(
        alias,
        generateKeyPairSync('ec', {
          namedCurve: 'P-256',
          publicKeyEncoding: { type: 'spki', format: 'pem' },
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        }),
      );
      return (await native.publicKey(alias)) ?? '';
    },
    sign: (alias, message) => {
      const pair = keys.get(alias);
      if (pair === undefined) return Promise.reject(new Error('There is no device key'));
      return Promise.resolve(
        sign('sha256', Buffer.from(message, 'utf8'), {
          key: pair.privateKey,
          dsaEncoding: 'der',
        }).toString('base64'),
      );
    },
    remove: (alias) => {
      keys.delete(alias);
      return Promise.resolve();
    },
  };
  return native;
}

async function verifiesLikeTheServer(publicKey: string, message: string, signature: string) {
  const key = await webcrypto.subtle.importKey(
    'spki',
    fromBase64(publicKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  return webcrypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    fromBase64(signature),
    new TextEncoder().encode(message),
  );
}

describe('[AUTH-007] [SEC-010] Keystore device key', () => {
  it('has no key on a fresh install, creates one, and finds it again after a restart', async () => {
    const native = fakeKeystore();
    const keys = new KeystoreDeviceKeys(() => Promise.resolve(native));
    expect(await keys.load()).toBeUndefined();
    const created = await keys.create();
    expect(created.algorithm).toBe('ES256');
    const loaded = await new KeystoreDeviceKeys(() => Promise.resolve(native)).load();
    expect(loaded?.publicKey).toBe(created.publicKey);
  });

  it('signs in the raw r‖s form the server verifies', async () => {
    const native = fakeKeystore();
    const keys = new KeystoreDeviceKeys(() => Promise.resolve(native));
    const key = await keys.create();
    // Enough signatures that some have r or s with a leading zero or a sign byte in DER.
    for (let index = 0; index < 40; index += 1) {
      const message = `rp-device-token:${String(index)}`;
      const signature = await key.sign(message);
      expect(fromBase64(signature)).toHaveLength(64);
      expect(await verifiesLikeTheServer(key.publicKey, message, signature)).toBe(true);
    }
  });

  it('forgets the key when the device is unpaired', async () => {
    const native = fakeKeystore();
    const keys = new KeystoreDeviceKeys(() => Promise.resolve(native));
    const key = await keys.create();
    await keys.remove();
    expect(await keys.load()).toBeUndefined();
    await expect(key.sign('x')).rejects.toThrow('There is no device key');
  });

  it('loads the Expo module by its name by default', async () => {
    const native = fakeKeystore();
    const requireNativeModule = vi.fn(() => native);
    vi.doMock('expo', () => ({ requireNativeModule }));
    await new KeystoreDeviceKeys().create();
    expect(requireNativeModule).toHaveBeenCalledWith('RpDeviceKey');
    vi.doUnmock('expo');
  });
});

describe('DER to raw ECDSA signatures', () => {
  it('pads short integers and strips sign bytes', () => {
    const r = [0x00, 0x80, ...new Array<number>(31).fill(1)]; // 33 bytes with a sign byte
    const s = [0x05]; // 1 byte
    const der = Uint8Array.from([
      0x30,
      4 + r.length + s.length,
      0x02,
      r.length,
      ...r,
      0x02,
      1,
      ...s,
    ]);
    const raw = derToRawEcdsa(der);
    expect(raw[0]).toBe(0x80);
    expect(raw[63]).toBe(0x05);
    expect(raw.subarray(32, 63).every((byte) => byte === 0)).toBe(true);
  });

  it('reads a long-form length', () => {
    const r = new Array<number>(33).fill(0x7f);
    r[0] = 0;
    const s = new Array<number>(33).fill(0x7f);
    s[0] = 0;
    const body = [0x02, 33, ...r, 0x02, 33, ...s];
    expect(derToRawEcdsa(Uint8Array.from([0x30, 0x81, body.length, ...body]))).toHaveLength(64);
  });

  it.each([
    ['not a sequence', [0x31, 0]],
    ['truncated', [0x30]],
    ['bad long form', [0x30, 0x82, 0, 0]],
    ['trailing bytes', [0x30, 3, 0x02, 1, 1, 0]],
    ['not an integer', [0x30, 3, 0x04, 1, 1]],
    ['integer runs past the end', [0x30, 3, 0x02, 5, 1]],
    ['integer too long', [0x30, 35, 0x02, 33, ...new Array<number>(33).fill(1)]],
    ['missing s', [0x30, 3, 0x02, 1, 1]],
    ['bytes after s', [0x30, 8, 0x02, 1, 1, 0x02, 1, 1, 0, 0]],
  ])('refuses a signature that is %s', (_name, bytes) => {
    expect(() => derToRawEcdsa(Uint8Array.from(bytes))).toThrow(TypeError);
  });

  it('decodes base64 with or without padding and refuses anything else', () => {
    expect([...fromBase64('AQID')]).toEqual([1, 2, 3]);
    expect([...fromBase64('AQ==')]).toEqual([1]);
    expect([...fromBase64('AQ')]).toEqual([1]);
    expect(() => fromBase64('A')).toThrow(TypeError);
    expect(() => fromBase64('A*B=')).toThrow(TypeError);
    expect(() => fromBase64('AQ===')).toThrow(TypeError);
    expect(() => fromBase64(`A${'='.repeat(100_000)}`)).toThrow(TypeError);
  });
});
