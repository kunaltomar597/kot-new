import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

function envName(name: SecretName): string {
  return `RP_SECRET_${name.toUpperCase().replaceAll('-', '_')}`;
}

/**
 * Secrets as files under `<dataDir>/secrets` (32 random bytes each, created with owner-only
 * permissions on first use), or from `RP_SECRET_<NAME>` environment variables (base64) when set.
 * For development, tests and CI. On the restaurant PC the installer wires the Windows DPAPI store
 * instead (P0-16, SEC-006).
 */
export class FileSecretStore implements WritableSecretStore {
  private readonly cache = new Map<SecretName, Promise<Buffer>>();

  constructor(
    private readonly directory: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get(name: SecretName): Promise<Buffer> {
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

  private async load(name: SecretName): Promise<Buffer> {
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

/**
 * The installation's secret store: files under `<dataDir>/secrets` for now; the installer swaps in
 * the Windows DPAPI store (P0-16, SEC-006).
 */
export function createSecretStore(config: { readonly dataDir: string }): WritableSecretStore {
  return new FileSecretStore(join(config.dataDir, 'secrets'));
}
