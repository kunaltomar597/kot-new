import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type Dpapi,
  dpapiScript,
  DPAPI_ENTROPY,
  encodedCommand,
  powerShellDpapi,
} from '../../src/auth/dpapi.js';
import {
  createSecretStore,
  DpapiSecretStore,
  FileSecretStore,
  INSTALLATION_SECRET_NAMES,
  SECRET_NAMES,
} from '../../src/auth/secret-store.js';
import { loadConfig } from '../../src/config/app-config.js';

/** Stands in for DPAPI: a reversible wrapping that is plainly not the secret, with call counts. */
function fakeDpapi(): Dpapi & { calls: { protect: number; unprotect: number }; broken: boolean } {
  const mask = (value: Buffer) => Buffer.from(value.map((byte) => byte ^ 0xa5));
  const fake = {
    calls: { protect: 0, unprotect: 0 },
    broken: false,
    protect(values: readonly Buffer[]) {
      fake.calls.protect += 1;
      return Promise.resolve(
        values.map((value) => Buffer.concat([Buffer.from('DPAPI:'), mask(value)])),
      );
    },
    unprotect(values: readonly Buffer[]) {
      fake.calls.unprotect += 1;
      if (fake.broken) return Promise.reject(new Error('Key not valid for use in specified state'));
      return Promise.resolve(
        values.map((value) => {
          if (!value.subarray(0, 6).equals(Buffer.from('DPAPI:'))) {
            throw new Error('The data is invalid');
          }
          return mask(value.subarray(6));
        }),
      );
    },
  };
  return fake;
}

const folder = () => mkdtempSync(join(tmpdir(), 'rp-dpapi-'));

describe('[SEC-006] the DPAPI secret store', () => {
  it('keeps each secret protected on disk and the same across processes', async () => {
    const directory = folder();
    const dpapi = fakeDpapi();
    const store = new DpapiSecretStore(directory, dpapi);
    const [first, again] = await Promise.all([store.get('pin-pepper'), store.get('pin-pepper')]);
    expect(first).toHaveLength(32);
    expect(again.equals(first)).toBe(true);
    const onDisk = readFileSync(join(directory, 'pin-pepper.dpapi'));
    expect(onDisk.includes(first)).toBe(false);
    expect(existsSync(join(directory, 'pin-pepper.key'))).toBe(false);
    // Another process (a new store) reads the same secret.
    const other = new DpapiSecretStore(directory, fakeDpapi());
    expect((await other.get('pin-pepper')).equals(first)).toBe(true);
    expect((await store.get('token-signing-key')).equals(first)).toBe(false);
  });

  it('reads every stored secret with one DPAPI call', async () => {
    const directory = folder();
    const created = await new DpapiSecretStore(directory, fakeDpapi()).ensure();
    expect(created).toEqual([...SECRET_NAMES, ...INSTALLATION_SECRET_NAMES]);
    const dpapi = fakeDpapi();
    const store = new DpapiSecretStore(directory, dpapi);
    await Promise.all([...SECRET_NAMES, ...INSTALLATION_SECRET_NAMES].map((n) => store.get(n)));
    expect(dpapi.calls).toEqual({ protect: 0, unprotect: 1 });
    expect(await store.ensure()).toEqual([]);
  });

  it('makes the missing secrets in one call and keeps the ones there', async () => {
    const directory = folder();
    const dpapi = fakeDpapi();
    const store = new DpapiSecretStore(directory, dpapi);
    const pepper = await store.get('pin-pepper');
    dpapi.calls.protect = 0;
    const made = await store.ensure();
    expect(made).not.toContain('pin-pepper');
    expect(made).toHaveLength(SECRET_NAMES.length + INSTALLATION_SECRET_NAMES.length - 1);
    expect(dpapi.calls.protect).toBe(1);
    expect((await store.get('pin-pepper')).equals(pepper)).toBe(true);
  });

  it('agrees on one value when two processes make the same secret at once', async () => {
    const directory = folder();
    const one = new DpapiSecretStore(directory, fakeDpapi());
    const two = new DpapiSecretStore(directory, fakeDpapi());
    const [a, b] = await Promise.all([one.get('backup-key'), two.get('backup-key')]);
    expect(a.equals(b)).toBe(true);
    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it("protects the development store's plain files and removes them", async () => {
    const directory = folder();
    const plain = await new FileSecretStore(directory, {}).get('totp-encryption-key');
    expect(existsSync(join(directory, 'totp-encryption-key.key'))).toBe(true);
    const store = new DpapiSecretStore(directory, fakeDpapi());
    expect((await store.get('totp-encryption-key')).equals(plain)).toBe(true);
    expect(existsSync(join(directory, 'totp-encryption-key.key'))).toBe(false);
    expect(existsSync(join(directory, 'totp-encryption-key.dpapi'))).toBe(true);
    expect(
      (await new DpapiSecretStore(directory, fakeDpapi()).get('totp-encryption-key')).equals(plain),
    ).toBe(true);
  });

  it('fails without caching when the secrets cannot be unprotected (another PC)', async () => {
    const directory = folder();
    await new DpapiSecretStore(directory, fakeDpapi()).get('pin-pepper');
    const dpapi = fakeDpapi();
    dpapi.broken = true;
    const store = new DpapiSecretStore(directory, dpapi);
    await expect(store.get('pin-pepper')).rejects.toThrow(/not valid/);
    dpapi.broken = false;
    expect(await store.get('pin-pepper')).toHaveLength(32);
  });

  it('[DATA-004] replaces secrets for a restore and can put the earlier ones back', async () => {
    const directory = folder();
    const store = new DpapiSecretStore(directory, fakeDpapi());
    const before = await store.get('pin-pepper');
    const restored = Buffer.alloc(32, 7);
    const undo = await store.replace({ 'pin-pepper': restored }, 'before-restore-1');
    expect((await store.get('pin-pepper')).equals(restored)).toBe(true);
    expect(
      (await new DpapiSecretStore(directory, fakeDpapi()).get('pin-pepper')).equals(restored),
    ).toBe(true);
    expect(existsSync(join(directory, 'before-restore-1', 'pin-pepper.dpapi'))).toBe(true);
    await undo();
    expect((await store.get('pin-pepper')).equals(before)).toBe(true);
    await expect(store.replace({ 'pin-pepper': Buffer.alloc(8) }, 'x')).rejects.toThrow(/short/);
    await expect(store.replace({}, '../x')).rejects.toThrow(/Unsafe/);
  });

  it('is what the configuration asks for', () => {
    expect(createSecretStore({ dataDir: folder() })).toBeInstanceOf(FileSecretStore);
    expect(createSecretStore({ dataDir: folder(), secretStore: 'dpapi' })).toBeInstanceOf(
      DpapiSecretStore,
    );
  });

  it('is required in production on Windows, and only works there', () => {
    const base = { DATABASE_URL: 'postgresql://u@127.0.0.1/rp' };
    expect(loadConfig(base).secretStore).toBe('file');
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' }, 'win32')).toThrow(/dpapi/);
    expect(
      loadConfig(
        { ...base, NODE_ENV: 'production', RP_SECRET_STORE: 'dpapi', RP_TLS: 'on' },
        'win32',
      ).secretStore,
    ).toBe('dpapi');
    expect(() => loadConfig({ ...base, RP_SECRET_STORE: 'dpapi' }, 'linux')).toThrow(/Windows/);
    expect(() => loadConfig({ ...base, RP_SECRET_STORE: 'vault' })).toThrow(/secretStore/);
  });

  it('asks Windows PowerShell for machine-scope DPAPI with our entropy, values on the pipes', () => {
    const script = dpapiScript('unprotect');
    expect(script).toContain('[Security.Cryptography.ProtectedData]::Unprotect(');
    expect(script).toContain('DataProtectionScope]::LocalMachine');
    expect(script).toContain(DPAPI_ENTROPY);
    expect(dpapiScript('protect')).toContain('::Protect(');
    expect(Buffer.from(encodedCommand(script), 'base64').toString('utf16le')).toBe(script);
  });

  it('reports a PowerShell that cannot run', async () => {
    const dpapi = powerShellDpapi({ powershell: join(folder(), 'missing-powershell.exe') });
    await expect(dpapi.protect([Buffer.alloc(32)])).rejects.toThrow(/ENOENT/);
    expect(await dpapi.unprotect([])).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('round-trips through the real DPAPI', async () => {
    const dpapi = powerShellDpapi();
    const values = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)];
    const blobs = await dpapi.protect(values);
    expect(blobs[0]?.equals(values[0] as Buffer)).toBe(false);
    const back = await dpapi.unprotect(blobs);
    expect(back.map((value) => value.toString('hex'))).toEqual(
      values.map((value) => value.toString('hex')),
    );
    const directory = folder();
    const store = new DpapiSecretStore(directory, dpapi);
    const secret = await store.get('backup-key');
    expect((await new DpapiSecretStore(directory).get('backup-key')).equals(secret)).toBe(true);
  });
});

describe('[SEC-002] installation secrets in the file store', () => {
  it('makes the database passwords with the other secrets', async () => {
    const directory = folder();
    const store = new FileSecretStore(directory, {});
    const made = await store.ensure();
    expect(made).toEqual([...SECRET_NAMES, ...INSTALLATION_SECRET_NAMES]);
    expect(await store.ensure()).toEqual([]);
    expect(await store.get('db-server-password')).toHaveLength(32);
  });
});
