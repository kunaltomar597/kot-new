import { FINGERPRINT_MATCHES_NEEDED, FINGERPRINT_SIZE } from '@rp/contracts/control-plane';
import { createHash } from 'node:crypto';

/**
 * The PC fingerprint (LIC-004): five hardware identifiers in a fixed order, each kept only as a
 * SHA-256 tied to the installation (so the vendor never holds serial numbers, and one PC gives
 * different fingerprints to different installations). Three of five must still match: a new
 * disk or network card is fine, a different PC is not.
 */
export const FINGERPRINT_KINDS = [
  'MACHINE_ID',
  'BOARD_SERIAL',
  'BIOS_UUID',
  'DISK_SERIAL',
  'CPU_ID',
] as const;
export type FingerprintKind = (typeof FINGERPRINT_KINDS)[number];

/** One identifier as the licence keeps it; null when the PC could not read it. */
export function fingerprintHash(
  installationId: string,
  kind: FingerprintKind,
  raw: string | null | undefined,
): string | null {
  const value = raw?.trim().toLowerCase() ?? '';
  // Placeholders some boards report instead of a serial identify nothing.
  if (value === '' || /^(0+|none|default string|to be filled by o\.e\.m\.?|unknown)$/.test(value)) {
    return null;
  }
  return createHash('sha256')
    .update(`rp-fingerprint:v1:${installationId}:${kind}:${value}`)
    .digest('hex');
}

/** The fingerprint from the identifiers read, in the fixed order. */
export function fingerprintOf(
  installationId: string,
  identifiers: Partial<Record<FingerprintKind, string | null>>,
): (string | null)[] {
  return FINGERPRINT_KINDS.map((kind) => fingerprintHash(installationId, kind, identifiers[kind]));
}

/** How many identifiers match, kind by kind; one the PC could not read never matches. */
export function fingerprintMatchCount(
  licensed: readonly (string | null)[],
  current: readonly (string | null)[],
): number {
  let matches = 0;
  for (let index = 0; index < FINGERPRINT_SIZE; index += 1) {
    const expected = licensed[index];
    if (expected !== null && expected !== undefined && expected === current[index]) matches += 1;
  }
  return matches;
}

/** Whether this is still the licensed PC: three of five identifiers match (LIC-004). */
export function isLicensedPc(
  licensed: readonly (string | null)[],
  current: readonly (string | null)[],
): boolean {
  return fingerprintMatchCount(licensed, current) >= FINGERPRINT_MATCHES_NEEDED;
}
