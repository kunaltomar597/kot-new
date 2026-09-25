import { randomBytes } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

/** Injection token for the `SecretStore`. */
export const SECRET_STORE = Symbol('SECRET_STORE');

/** Local secrets that never live in the database or the source (SEC-002, SEC-006). */
export const SECRET_NAMES = [
  'pin-pepper',
  'token-signing-key',
  'device-token-key',
  'totp-encryption-key',
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

const SECRET_BYTES = 32;

export interface SecretStore {
  /** The secret's bytes; created on first use if the store supports it. */
  get(name: SecretName): Promise<Buffer>;
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
export class FileSecretStore implements SecretStore {
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
