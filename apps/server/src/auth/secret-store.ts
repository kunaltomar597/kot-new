import { randomBytes, randomUUID } from 'node:crypto';
import {
  access,
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { type Dpapi, powerShellDpapi } from './dpapi.js';

/** Injection token for the `SecretStore`. */
export const SECRET_STORE = Symbol('SECRET_STORE');

/** Local secrets that never live in the database or the source (SEC-002, SEC-006). */
export const SECRET_NAMES = [
  'pin-pepper',
  'token-signing-key',
  'device-token-key',
  'totp-encryption-key',
  /** Encrypts the LAN TLS private keys at rest (P0-15, ADR-0011). */
  'tls-key-encryption-key',
  /** Seed of the installation's Ed25519 key for the Vendor Control Plane (P0-17b, ADR-0012). */
  'installation-signing-key',
  /** Seals the QR relay credential the Control Plane issues, stored in the database (P5-03a). */
  'relay-credential-key',
  /**
   * Seals the licence agent's record (last time seen, restriction, reactivation) and the
   * reactivation secret, so they cannot be edited in the database unnoticed (LIC-007, P7-01c).
   */
  'licence-record-key',
  /**
   * Encrypts the backups (DATA-003, SEC-007, P7-05a). Never inside a backup; escrowed with the
   * vendor for a restore on a new PC (P7-05e).
   */
  'backup-key',
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/**
 * The installation's own secrets: the database logins' passwords (P0-16b). Kept in the same store
 * but never in a backup, so a restore on a new PC keeps that PC's logins.
 */
export const INSTALLATION_SECRET_NAMES = [
  'db-admin-password',
  'db-migrator-password',
  'db-server-password',
  'db-purger-password',
  'db-backup-password',
] as const;
export type InstallationSecretName = (typeof INSTALLATION_SECRET_NAMES)[number];

/** Every name a local store holds. */
export type StoredSecretName = SecretName | InstallationSecretName;
const STORED_SECRET_NAMES: readonly StoredSecretName[] = [
  ...SECRET_NAMES,
  ...INSTALLATION_SECRET_NAMES,
];

const SECRET_BYTES = 32;

export interface SecretStore {
  /** The secret's bytes; created on first use if the store supports it. */
  get(name: SecretName): Promise<Buffer>;
}

/** A store a restore can write to (DATA-004, P7-05b). */
export interface WritableSecretStore extends SecretStore {
  /**
   * Replaces these secrets with a backup's, keeping the ones there before under `keepAs`.
   * Returns a function that puts the earlier ones back.
   */
  replace(
    values: Partial<Record<SecretName, Buffer>>,
    keepAs: string,
  ): Promise<() => Promise<void>>;
}

/** The store on this PC: the application's secrets and the installation's (P0-16b). */
export interface LocalSecretStore extends WritableSecretStore {
  get(name: StoredSecretName): Promise<Buffer>;
  /** Makes the missing ones now (the installer, so the first start is quick); returns their names. */
  ensure(names?: readonly StoredSecretName[]): Promise<StoredSecretName[]>;
}

function envName(name: StoredSecretName): string {
  return `RP_SECRET_${name.toUpperCase().replaceAll('-', '_')}`;
}

/**
 * Secrets as files under `<dataDir>/secrets` (32 random bytes each, created with owner-only
 * permissions on first use), or from `RP_SECRET_<NAME>` environment variables (base64) when set.
 * For development, tests and CI. On the restaurant PC the installer sets `RP_SECRET_STORE=dpapi`
 * for the Windows DPAPI store instead (P0-16b, SEC-006).
 */
export class FileSecretStore implements LocalSecretStore {
  private readonly cache = new Map<StoredSecretName, Promise<Buffer>>();

  constructor(
    private readonly directory: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async ensure(
    names: readonly StoredSecretName[] = STORED_SECRET_NAMES,
  ): Promise<StoredSecretName[]> {
    const created: StoredSecretName[] = [];
    for (const name of names) {
      const fromEnv = this.env[envName(name)];
      const existed =
        (fromEnv !== undefined && fromEnv !== '') ||
        (await access(join(this.directory, `${name}.key`)).then(
          () => true,
          () => false,
        ));
      await this.get(name);
      if (!existed) created.push(name);
    }
    return created;
  }

  get(name: StoredSecretName): Promise<Buffer> {
    let secret = this.cache.get(name);
    if (secret === undefined) {
      secret = this.load(name);
      // A failed load is retried next time instead of being cached.
      secret.catch(() => this.cache.delete(name));
      this.cache.set(name, secret);
    }
    return secret;
  }

  async replace(
    values: Partial<Record<SecretName, Buffer>>,
    keepAs: string,
  ): Promise<() => Promise<void>> {
    if (!/^[a-z0-9-]+$/.test(keepAs)) throw new Error(`Unsafe folder name: ${keepAs}`);
    const names = SECRET_NAMES.filter((name) => values[name] !== undefined);
    for (const name of names) {
      const fromEnv = this.env[envName(name)];
      if (fromEnv !== undefined && fromEnv !== '') {
        throw new Error(`${envName(name)} is set, so ${name} cannot be restored. Unset it first.`);
      }
    }
    const kept = join(this.directory, keepAs);
    await mkdir(kept, { recursive: true, mode: 0o700 });
    const replaced: { name: SecretName; hadOne: boolean }[] = [];
    const undo = async () => {
      for (const { name, hadOne } of replaced.reverse()) {
        const path = join(this.directory, `${name}.key`);
        if (hadOne) await copyFile(join(kept, `${name}.key`), path);
        else await rm(path, { force: true });
        this.cache.delete(name);
      }
    };
    try {
      for (const name of names) {
        const value = values[name];
        if (value === undefined || value.length < SECRET_BYTES) {
          throw new Error(`The restored ${name} is too short`);
        }
        const path = join(this.directory, `${name}.key`);
        const hadOne = await copyFile(path, join(kept, `${name}.key`)).then(
          () => true,
          (error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw error;
          },
        );
        replaced.push({ name, hadOne });
        // Written beside it, then renamed over it: never half a key.
        await writeFile(`${path}.new`, value.subarray(0, SECRET_BYTES), { mode: 0o600 });
        await rename(`${path}.new`, path);
        this.cache.delete(name);
      }
    } catch (error) {
      await undo();
      throw error;
    }
    return undo;
  }

  private async load(name: StoredSecretName): Promise<Buffer> {
    const fromEnv = this.env[envName(name)];
    if (fromEnv !== undefined && fromEnv !== '') {
      const bytes = Buffer.from(fromEnv, 'base64');
      if (bytes.length < SECRET_BYTES) {
        throw new Error(
          `${envName(name)} must be at least ${String(SECRET_BYTES)} bytes, base64 encoded`,
        );
      }
      return bytes;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // One open, then everything through the handle: no check-then-use on the path that another
    // process could exploit (CWE-367). 'a+' creates the file if missing. If two processes start at
    // once, both append 32 random bytes (appends are atomic) and both read the first 32, so they
    // agree on the same secret.
    const handle = await open(join(this.directory, `${name}.key`), 'a+', 0o600);
    try {
      if (process.platform !== 'win32') await handle.chmod(0o600);
      if ((await handle.stat()).size === 0) await handle.appendFile(randomBytes(SECRET_BYTES));
      const bytes = Buffer.alloc(SECRET_BYTES);
      const { bytesRead } = await handle.read(bytes, 0, SECRET_BYTES, 0);
      if (bytesRead < SECRET_BYTES) throw new Error(`Secret file for ${name} is too short`);
      return bytes;
    } finally {
      await handle.close();
    }
  }
}

/** A temporary file beside `path`, linked into place only if nothing is there yet. */
async function writeOnce(path: string, bytes: Buffer): Promise<boolean> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    // A file system without hard links: create it exclusively instead.
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'ENOSYS') {
      try {
        await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
        return true;
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw inner;
      }
    }
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

/** The value at `index` of what DPAPI returned, which has one per value given. */
function nth(values: readonly Buffer[], index: number): Buffer {
  const value = values[index];
  if (value === undefined) throw new Error('DPAPI returned fewer values than it was given');
  return value;
}

/** A file's bytes, or undefined when it is not there. */
async function readIfThere(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * The restaurant PC's store (SEC-006, P0-16b): each secret is 32 random bytes protected with
 * Windows DPAPI, one `<name>.dpapi` file each under `<dataDir>/secrets`. The first read unprotects
 * every stored secret in one call. A plain `<name>.key` left by the development store is protected
 * and then removed. Environment variables never stand in for a secret here.
 */
export class DpapiSecretStore implements LocalSecretStore {
  private loaded: Promise<Map<StoredSecretName, Buffer>> | undefined;
  private readonly creating = new Map<StoredSecretName, Promise<Buffer>>();

  constructor(
    private readonly directory: string,
    private readonly dpapi: Dpapi = powerShellDpapi(),
  ) {}

  private path(name: StoredSecretName): string {
    return join(this.directory, `${name}.dpapi`);
  }

  async get(name: StoredSecretName): Promise<Buffer> {
    const known = (await this.load()).get(name);
    if (known !== undefined) return known;
    return nth(await this.create([name]), 0);
  }

  async ensure(
    names: readonly StoredSecretName[] = STORED_SECRET_NAMES,
  ): Promise<StoredSecretName[]> {
    const secrets = await this.load();
    const missing = names.filter((name) => !secrets.has(name));
    await this.create(missing);
    return missing;
  }

  async replace(
    values: Partial<Record<SecretName, Buffer>>,
    keepAs: string,
  ): Promise<() => Promise<void>> {
    if (!/^[a-z0-9-]+$/.test(keepAs)) throw new Error(`Unsafe folder name: ${keepAs}`);
    const names = SECRET_NAMES.filter((name) => values[name] !== undefined);
    for (const name of names) {
      const value = values[name];
      if (value === undefined || value.length < SECRET_BYTES) {
        throw new Error(`The restored ${name} is too short`);
      }
    }
    const protectedValues = await this.dpapi.protect(
      names.map((name) => (values[name] ?? Buffer.alloc(0)).subarray(0, SECRET_BYTES)),
    );
    const kept = join(this.directory, keepAs);
    await mkdir(kept, { recursive: true, mode: 0o700 });
    const replaced: { name: SecretName; hadOne: boolean }[] = [];
    const undo = async () => {
      for (const { name, hadOne } of replaced.reverse()) {
        if (hadOne) await copyFile(join(kept, `${name}.dpapi`), this.path(name));
        else await rm(this.path(name), { force: true });
      }
      this.loaded = undefined;
    };
    try {
      for (const [index, name] of names.entries()) {
        const hadOne = await copyFile(this.path(name), join(kept, `${name}.dpapi`)).then(
          () => true,
          (error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw error;
          },
        );
        replaced.push({ name, hadOne });
        // Written beside it, then renamed over it: never half a key.
        await writeFile(`${this.path(name)}.new`, nth(protectedValues, index), {
          mode: 0o600,
        });
        await rename(`${this.path(name)}.new`, this.path(name));
      }
    } catch (error) {
      await undo();
      throw error;
    } finally {
      this.loaded = undefined;
    }
    return undo;
  }

  private load(): Promise<Map<StoredSecretName, Buffer>> {
    if (this.loaded === undefined) {
      const loading = this.readAll();
      // A failed read is tried again next time instead of being kept.
      loading.catch(() => {
        if (this.loaded === loading) this.loaded = undefined;
      });
      this.loaded = loading;
    }
    return this.loaded;
  }

  private async readAll(): Promise<Map<StoredSecretName, Buffer>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stored: { name: StoredSecretName; blob: Buffer }[] = [];
    const plain: { name: StoredSecretName; bytes: Buffer }[] = [];
    for (const name of STORED_SECRET_NAMES) {
      const blob = await readIfThere(this.path(name));
      if (blob !== undefined) {
        stored.push({ name, blob });
        continue;
      }
      const bytes = await readIfThere(join(this.directory, `${name}.key`));
      if (bytes !== undefined) {
        if (bytes.length < SECRET_BYTES) throw new Error(`Secret file for ${name} is too short`);
        plain.push({ name, bytes: bytes.subarray(0, SECRET_BYTES) });
      }
    }
    const secrets = new Map<StoredSecretName, Buffer>();
    const values =
      stored.length === 0 ? [] : await this.dpapi.unprotect(stored.map(({ blob }) => blob));
    for (const [index, { name }] of stored.entries()) {
      const value = nth(values, index);
      if (value.length < SECRET_BYTES) throw new Error(`The stored ${name} is too short`);
      secrets.set(name, value);
    }
    // The development store's plain files, from before this PC used DPAPI: protected, then gone.
    const protectedPlain =
      plain.length === 0 ? [] : await this.dpapi.protect(plain.map(({ bytes }) => bytes));
    for (const [index, { name, bytes }] of plain.entries()) {
      if (await writeOnce(this.path(name), nth(protectedPlain, index))) {
        secrets.set(name, bytes);
      } else {
        // Another process got there first: theirs counts.
        const theirs = await this.dpapi.unprotect([await readFile(this.path(name))]);
        secrets.set(name, nth(theirs, 0));
      }
      await rm(join(this.directory, `${name}.key`), { force: true });
    }
    return secrets;
  }

  /** Makes new secrets; a name another process made meanwhile keeps that process's value. */
  private async create(names: readonly StoredSecretName[]): Promise<Buffer[]> {
    const fresh = names.filter((name) => !this.creating.has(name));
    if (fresh.length > 0) {
      const making = (async () => {
        const values = fresh.map(() => randomBytes(SECRET_BYTES));
        const blobs = await this.dpapi.protect(values);
        const secrets = await this.load();
        const result = new Map<StoredSecretName, Buffer>();
        for (const [index, name] of fresh.entries()) {
          const value = (await writeOnce(this.path(name), nth(blobs, index)))
            ? nth(values, index)
            : // Another process made it meanwhile: theirs counts.
              nth(await this.dpapi.unprotect([await readFile(this.path(name))]), 0);
          result.set(name, value);
          secrets.set(name, value);
        }
        return result;
      })();
      for (const name of fresh) {
        const one = making.then((result) => {
          const value = result.get(name);
          if (value === undefined) throw new Error(`${name} was not made`);
          return value;
        });
        one.catch(() => undefined).finally(() => this.creating.delete(name));
        this.creating.set(name, one);
      }
    }
    return Promise.all(
      names.map(
        (name) => this.creating.get(name) ?? Promise.reject(new Error(`${name} was not made`)),
      ),
    );
  }
}

/** Where the secrets are kept: plain files (development, tests) or DPAPI (the restaurant PC). */
export type SecretStoreKind = 'file' | 'dpapi';

/**
 * The installation's secret store under `<dataDir>/secrets`: DPAPI when the installer set
 * `RP_SECRET_STORE=dpapi` (P0-16b, SEC-006), files otherwise.
 */
export function createSecretStore(config: {
  readonly dataDir: string;
  readonly secretStore?: SecretStoreKind;
}): LocalSecretStore {
  const directory = join(config.dataDir, 'secrets');
  return config.secretStore === 'dpapi'
    ? new DpapiSecretStore(directory)
    : new FileSecretStore(directory);
}
