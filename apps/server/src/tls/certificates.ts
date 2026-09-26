import { randomBytes, webcrypto, X509Certificate } from 'node:crypto';
import * as x509 from '@peculiar/x509';

/**
 * The installation's private certificate authority and the server certificate it issues
 * (ADR-0011, SEC-001): ECDSA P-256, created with WebCrypto, as PEM for Node's TLS.
 */

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGNING_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;
const DAY_MS = 86_400_000;

/** The CA lasts 10 years: devices pin it, so it should rarely change. */
export const CA_VALIDITY_DAYS = 3_650;
/** Inside every browser's limit for server certificates (398 days). */
export const SERVER_VALIDITY_DAYS = 397;
/** Server certificates are renewed this long before they expire. */
export const RENEW_BEFORE_DAYS = 30;

export interface KeyedCertificate {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
}

/** The names a server certificate covers. */
export interface ServerNames {
  readonly dnsNames: readonly string[];
  readonly ipAddresses: readonly string[];
}

function pem(label: string, der: ArrayBuffer): string {
  const base64 = Buffer.from(der).toString('base64');
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function derOf(pemText: string): Buffer {
  const base64 = pemText
    .split('\n')
    .filter((line) => !line.startsWith('-----'))
    .join('');
  return Buffer.from(base64, 'base64');
}

async function exportPrivateKey(key: webcrypto.CryptoKey): Promise<string> {
  return pem('PRIVATE KEY', await webcrypto.subtle.exportKey('pkcs8', key));
}

async function importSigningKey(privateKeyPem: string): Promise<webcrypto.CryptoKey> {
  return webcrypto.subtle.importKey('pkcs8', derOf(privateKeyPem), KEY_ALGORITHM, false, ['sign']);
}

function serialNumber(): string {
  // Positive (top bit clear) and unpredictable.
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  return bytes.toString('hex');
}

/** A new CA for this installation. */
export async function createCertificateAuthority(
  now: Date = new Date(),
  label: string = randomBytes(4).toString('hex'),
): Promise<KeyedCertificate> {
  const keys = await webcrypto.subtle.generateKey(KEY_ALGORITHM, true, ['sign', 'verify']);
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serialNumber(),
    name: `CN=Restaurant Operations Platform Local CA ${label}, O=Restaurant Operations Platform`,
    notBefore: new Date(now.getTime() - DAY_MS),
    notAfter: new Date(now.getTime() + CA_VALIDITY_DAYS * DAY_MS),
    signingAlgorithm: SIGNING_ALGORITHM,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return {
    certificatePem: certificate.toString('pem'),
    privateKeyPem: await exportPrivateKey(keys.privateKey),
  };
}

/** A server certificate for `names`, signed by `ca`. */
export async function issueServerCertificate(
  ca: KeyedCertificate,
  names: ServerNames,
  now: Date = new Date(),
): Promise<KeyedCertificate> {
  if (names.dnsNames.length + names.ipAddresses.length === 0) {
    throw new Error('A server certificate needs at least one name or address');
  }
  const caCertificate = new x509.X509Certificate(ca.certificatePem);
  const keys = await webcrypto.subtle.generateKey(KEY_ALGORITHM, true, ['sign', 'verify']);
  const certificate = await x509.X509CertificateGenerator.create({
    serialNumber: serialNumber(),
    subject: `CN=${names.dnsNames[0] ?? names.ipAddresses[0] ?? 'server'}`,
    issuer: caCertificate.subject,
    notBefore: new Date(now.getTime() - DAY_MS),
    notAfter: new Date(now.getTime() + SERVER_VALIDITY_DAYS * DAY_MS),
    signingAlgorithm: SIGNING_ALGORITHM,
    publicKey: keys.publicKey,
    signingKey: await importSigningKey(ca.privateKeyPem),
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      new x509.SubjectAlternativeNameExtension([
        ...names.dnsNames.map((value) => ({ type: 'dns' as const, value })),
        ...names.ipAddresses.map((value) => ({ type: 'ip' as const, value })),
      ]),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(caCertificate.publicKey),
    ],
  });
  return {
    certificatePem: certificate.toString('pem'),
    privateKeyPem: await exportPrivateKey(keys.privateKey),
  };
}

/** SHA-256 fingerprint as shown to people and pinned by apps, e.g. `AB:CD:…`. */
export function fingerprintOf(certificatePem: string): string {
  return new X509Certificate(certificatePem).fingerprint256;
}

export function expiryOf(certificatePem: string): Date {
  return new Date(new X509Certificate(certificatePem).validTo);
}

/** The DNS names and IP addresses a certificate covers. */
export function namesOf(certificatePem: string): ServerNames {
  const dnsNames: string[] = [];
  const ipAddresses: string[] = [];
  for (const entry of (new X509Certificate(certificatePem).subjectAltName ?? '').split(', ')) {
    if (entry.startsWith('DNS:')) dnsNames.push(entry.slice(4));
    else if (entry.startsWith('IP Address:')) ipAddresses.push(entry.slice(11));
  }
  return { dnsNames, ipAddresses };
}

/** True when the certificate was issued by `caPem` (its signature verifies with the CA key). */
export function isIssuedBy(certificatePem: string, caPem: string): boolean {
  const certificate = new X509Certificate(certificatePem);
  const ca = new X509Certificate(caPem);
  return certificate.checkIssued(ca) && certificate.verify(ca.publicKey);
}

/**
 * A server certificate must be replaced when it is about to expire, is not valid yet (issued while
 * the PC's clock was ahead), was issued by another CA, or no longer covers every name and address
 * the server has (a new DHCP lease, a renamed PC).
 */
export function needsRenewal(
  server: KeyedCertificate,
  caPem: string,
  names: ServerNames,
  now: Date = new Date(),
): boolean {
  const certificate = new X509Certificate(server.certificatePem);
  if (new Date(certificate.validTo).getTime() - now.getTime() < RENEW_BEFORE_DAYS * DAY_MS) {
    return true;
  }
  if (new Date(certificate.validFrom).getTime() > now.getTime()) return true;
  if (!isIssuedBy(server.certificatePem, caPem)) return true;
  const covered = namesOf(server.certificatePem);
  const dns = new Set(covered.dnsNames.map((name) => name.toLowerCase()));
  const ips = new Set(covered.ipAddresses);
  return (
    names.dnsNames.some((name) => !dns.has(name.toLowerCase())) ||
    names.ipAddresses.some((address) => !ips.has(address))
  );
}
