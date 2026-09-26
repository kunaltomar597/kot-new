import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { SecureContextOptions } from 'node:tls';
import { open as unseal, seal } from '../auth/secret-box.js';
import type { SecretStore } from '../auth/secret-store.js';
import {
  createCertificateAuthority,
  expiryOf,
  fingerprintOf,
  issueServerCertificate,
  type KeyedCertificate,
  namesOf,
  needsRenewal,
  type ServerNames,
} from './certificates.js';

/** What the HTTPS server and the pairing screen need (ADR-0011). */
export interface TlsMaterial {
  /** Server private key and certificate (PEM). */
  readonly key: string;
  readonly cert: string;
  /** When the server certificate expires (it is renewed 30 days before). */
  readonly expiresAt: Date;
  /** The names and addresses the server certificate covers. */
  readonly names: ServerNames;
  /** The installation's CA certificate (PEM), its SHA-256 fingerprint (apps pin it) and expiry. */
  readonly ca: string;
  readonly caFingerprint: string;
  readonly caExpiresAt: Date;
}

/** TLS 1.2 is the oldest protocol the server accepts, whatever Node's defaults (SEC-001). */
export const TLS_MIN_VERSION = 'TLSv1.2';

/** Options for `https.createServer` and `server.setSecureContext`. */
export function serverTlsOptions(
  material: TlsMaterial,
): Required<Pick<SecureContextOptions, 'key' | 'cert' | 'minVersion'>> {
  return { key: material.key, cert: material.cert, minVersion: TLS_MIN_VERSION };
}

const FILES = {
  /** Sealed JSON of the CA's certificate and key: one file, so one atomic write. */
  ca: 'ca.sealed',
  server: 'server.sealed',
  /** A plain copy of the CA certificate for people to install; never read back. */
  caCertificate: 'ca.crt',
} as const;

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The names the server certificate must cover: every non-internal IPv4 address of this PC (its
 * DHCP-reserved LAN address), `127.0.0.1`, `localhost`, the computer's name (also as `<name>.local`
 * for mDNS) and any configured host names.
 */
export function localServerNames(
  extraHostnames: readonly string[] = [],
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
  computerName: string = hostname(),
): ServerNames {
  const ipAddresses = new Set(['127.0.0.1']);
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) ipAddresses.add(entry.address);
    }
  }
  const dnsNames = new Set(['localhost']);
  const label = computerName.toLowerCase();
  if (HOST_LABEL.test(label)) dnsNames.add(label).add(`${label}.local`);
  for (const name of extraHostnames) dnsNames.add(name.toLowerCase());
  return { dnsNames: [...dnsNames], ipAddresses: [...ipAddresses].sort() };
}

function keyedCertificate(json: string): KeyedCertificate {
  const value: unknown = JSON.parse(json);
  if (
    typeof value === 'object' &&
    value !== null &&
    'certificatePem' in value &&
    'privateKeyPem' in value &&
    typeof value.certificatePem === 'string' &&
    typeof value.privateKeyPem === 'string'
  ) {
    return { certificatePem: value.certificatePem, privateKeyPem: value.privateKeyPem };
  }
  throw new Error('Unrecognised TLS material');
}

/**
 * The CA and server certificate under `<dataDir>/tls`. Each certificate is stored with its private
 * key as one file sealed with AES-256-GCM under `tls-key-encryption-key` from the secret store, so
 * the files alone are useless (SEC-006) and a crash mid-renewal never pairs a certificate with
 * the wrong key. Calls are serialised; one server process per installation.
 */
export class TlsStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly secrets: SecretStore,
  ) {}

  /**
   * The current material: creates the CA on first use and (re)issues the server certificate when
   * it is missing, near expiry, not valid yet or no longer covers `names`. `renewed` says a new
   * one was issued.
   */
  ensure(
    names: ServerNames,
    now: Date = new Date(),
  ): Promise<{ material: TlsMaterial; renewed: boolean }> {
    const result = this.queue.then(() => this.ensureNow(names, now));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async ensureNow(
    names: ServerNames,
    now: Date,
  ): Promise<{ material: TlsMaterial; renewed: boolean }> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let ca = await this.read(FILES.ca);
    if (ca === undefined) {
      ca = await createCertificateAuthority(now);
      await this.write(FILES.ca, ca);
    }
    // Rewritten when it differs, so people always copy the CA the server really uses.
    const published = await readFile(join(this.directory, FILES.caCertificate), 'utf8').catch(
      missing,
    );
    if (published !== ca.certificatePem) {
      await this.atomically(FILES.caCertificate, ca.certificatePem, 0o644);
    }
    let server = await this.read(FILES.server);
    let renewed = false;
    if (server === undefined || needsRenewal(server, ca.certificatePem, names, now)) {
      server = await issueServerCertificate(ca, names, now);
      await this.write(FILES.server, server);
      renewed = true;
    }
    return {
      material: {
        key: server.privateKeyPem,
        cert: server.certificatePem,
        expiresAt: expiryOf(server.certificatePem),
        names: namesOf(server.certificatePem),
        ca: ca.certificatePem,
        caFingerprint: fingerprintOf(ca.certificatePem),
        caExpiresAt: expiryOf(ca.certificatePem),
      },
      renewed,
    };
  }

  private async read(file: string): Promise<KeyedCertificate | undefined> {
    const sealed = await readFile(join(this.directory, file), 'utf8').catch(missing);
    if (sealed === undefined) return undefined;
    const key = await this.secrets.get('tls-key-encryption-key');
    return keyedCertificate(unseal(key, sealed.trim()).toString('utf8'));
  }

  private async write(file: string, keyed: KeyedCertificate): Promise<void> {
    const key = await this.secrets.get('tls-key-encryption-key');
    const json = JSON.stringify({
      certificatePem: keyed.certificatePem,
      privateKeyPem: keyed.privateKeyPem,
    });
    await this.atomically(file, seal(key, Buffer.from(json, 'utf8')), 0o600);
  }

  private async atomically(file: string, content: string, mode: number): Promise<void> {
    const target = join(this.directory, file);
    const temporary = `${target}.${String(process.pid)}.tmp`;
    await writeFile(temporary, content, { mode });
    await rename(temporary, target);
  }
}

function missing(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
  throw error;
}
