import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SecretName, SecretStore } from '../../src/auth/secret-store.js';
import {
  createCertificateAuthority,
  expiryOf,
  fingerprintOf,
  isIssuedBy,
  issueServerCertificate,
  namesOf,
  needsRenewal,
} from '../../src/tls/certificates.js';
import { localServerNames, TlsStore } from '../../src/tls/tls-store.js';

const DAY = 86_400_000;
const NOW = new Date('2026-09-26T10:00:00.000Z');
const NAMES = { dnsNames: ['localhost', 'pos.local'], ipAddresses: ['127.0.0.1', '192.168.1.10'] };

class MemorySecrets implements SecretStore {
  private readonly values = new Map<SecretName, Buffer>();

  constructor(private readonly fill = 7) {}

  get(name: SecretName): Promise<Buffer> {
    let value = this.values.get(name);
    if (value === undefined) {
      value = Buffer.alloc(32, this.fill);
      this.values.set(name, value);
    }
    return Promise.resolve(value);
  }
}

describe('[SEC-001] the installation CA and server certificate (ADR-0011)', () => {
  it('creates a 10-year CA that may only sign certificates', async () => {
    const ca = await createCertificateAuthority(NOW, 'test');
    const certificate = new X509Certificate(ca.certificatePem);
    expect(certificate.ca).toBe(true);
    expect(certificate.subject).toContain('Restaurant Operations Platform Local CA test');
    expect(certificate.checkIssued(certificate)).toBe(true);
    expect(expiryOf(ca.certificatePem).getTime() - NOW.getTime()).toBeGreaterThan(3_649 * DAY);
    expect(ca.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(fingerprintOf(ca.certificatePem)).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('issues a 397-day server certificate for every LAN name and address', async () => {
    const ca = await createCertificateAuthority(NOW);
    const server = await issueServerCertificate(ca, NAMES, NOW);
    const certificate = new X509Certificate(server.certificatePem);
    expect(certificate.ca).toBe(false);
    expect(isIssuedBy(server.certificatePem, ca.certificatePem)).toBe(true);
    expect(namesOf(server.certificatePem)).toEqual(NAMES);
    expect(certificate.checkIP('192.168.1.10')).toBe('192.168.1.10');
    expect(certificate.checkHost('pos.local')).toBe('pos.local');
    expect(certificate.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
    const days = (expiryOf(server.certificatePem).getTime() - NOW.getTime()) / DAY;
    expect(Math.round(days)).toBe(397);
    await expect(
      issueServerCertificate(ca, { dnsNames: [], ipAddresses: [] }, NOW),
    ).rejects.toThrow(/at least one name/);
  });

  it('renews near expiry, before validity, for new addresses, or when another CA issued it', async () => {
    const ca = await createCertificateAuthority(NOW);
    const other = await createCertificateAuthority(NOW);
    const server = await issueServerCertificate(ca, NAMES, NOW);
    expect(needsRenewal(server, ca.certificatePem, NAMES, NOW)).toBe(false);
    expect(
      needsRenewal(server, ca.certificatePem, NAMES, new Date(NOW.getTime() + 370 * DAY)),
    ).toBe(true);
    const moved = { ...NAMES, ipAddresses: ['127.0.0.1', '192.168.1.44'] };
    expect(needsRenewal(server, ca.certificatePem, moved, NOW)).toBe(true);
    const renamed = { ...NAMES, dnsNames: ['localhost', 'POS.LOCAL'] };
    expect(needsRenewal(server, ca.certificatePem, renamed, NOW)).toBe(false);
    expect(needsRenewal(server, other.certificatePem, NAMES, NOW)).toBe(true);
    // Issued while the clock was ahead: not valid yet once the clock is corrected.
    const early = await issueServerCertificate(ca, NAMES, new Date(NOW.getTime() + 30 * DAY));
    expect(needsRenewal(early, ca.certificatePem, NAMES, NOW)).toBe(true);
  });

  it('names the PC by its LAN addresses, loopback, localhost and computer name', () => {
    const names = localServerNames(
      ['Kitchen.Example.lan'],
      {
        eth0: [
          { address: '192.168.1.10', family: 'IPv4', internal: false } as never,
          { address: 'fe80::1', family: 'IPv6', internal: false } as never,
        ],
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
      },
      'DESKTOP-POS1',
    );
    expect(names).toEqual({
      dnsNames: ['localhost', 'desktop-pos1', 'desktop-pos1.local', 'kitchen.example.lan'],
      ipAddresses: ['127.0.0.1', '192.168.1.10'],
    });
    expect(localServerNames([], {}, 'not a valid_name').dnsNames).toEqual(['localhost']);
  });
});

describe('[SEC-006] TLS material at rest', () => {
  it('keeps keys sealed, reuses the CA and renews the server certificate when needed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rp-tls-'));
    const store = new TlsStore(directory, new MemorySecrets());

    const first = await store.ensure(NAMES, NOW);
    expect(first.renewed).toBe(true);
    expect(readdirSync(directory).sort()).toEqual(['ca.crt', 'ca.sealed', 'server.sealed']);
    for (const sealed of ['ca.sealed', 'server.sealed']) {
      expect(readFileSync(join(directory, sealed), 'utf8')).not.toMatch(/PRIVATE KEY|CERTIFICATE/);
    }
    // The plain copy people install is the CA the server uses.
    expect(readFileSync(join(directory, 'ca.crt'), 'utf8')).toBe(first.material.ca);
    expect(first.material.caExpiresAt.getTime() - NOW.getTime()).toBeGreaterThan(3_649 * DAY);

    const again = await store.ensure(NAMES, NOW);
    expect(again.renewed).toBe(false);
    expect(again.material.cert).toBe(first.material.cert);

    const moved = await store.ensure({ ...NAMES, ipAddresses: ['10.0.0.5'] }, NOW);
    expect(moved.renewed).toBe(true);
    expect(moved.material.caFingerprint).toBe(first.material.caFingerprint);
    expect(moved.material.names.ipAddresses).toEqual(['10.0.0.5']);

    const later = await store.ensure(NAMES, new Date(NOW.getTime() + 380 * DAY));
    expect(later.renewed).toBe(true);
    expect(later.material.expiresAt.getTime()).toBeGreaterThan(first.material.expiresAt.getTime());

    await expect(
      new TlsStore(directory, new MemorySecrets(9)).ensure(NAMES, NOW),
    ).rejects.toThrow();
  });

  it('serialises renewals, so concurrent checks issue one certificate', async () => {
    const store = new TlsStore(mkdtempSync(join(tmpdir(), 'rp-tls-')), new MemorySecrets());
    const results = await Promise.all([store.ensure(NAMES, NOW), store.ensure(NAMES, NOW)]);
    expect(results.map((result) => result.renewed)).toEqual([true, false]);
    expect(results[1].material.cert).toBe(results[0].material.cert);
  });
});
