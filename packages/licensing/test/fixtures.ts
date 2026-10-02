import type { LicencePayload } from '@rp/contracts/control-plane';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { fingerprintOf } from '../src/fingerprint.js';

/** A vendor key pair made for the test; production keys live in the cloud KMS. */
export function vendorKeys(): { privateKey: KeyObject; spki: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
}

export const INSTALLATION = '0199a0e0-0000-7000-8000-00000000a001';
export const IDENTIFIERS = {
  MACHINE_ID: '6c1f2b',
  BOARD_SERIAL: 'BSN-1234',
  BIOS_UUID: '4C4C4544-0035',
  DISK_SERIAL: 'WD-123',
  CPU_ID: 'BFEBFBFF000906EA',
} as const;
export const FINGERPRINT = fingerprintOf(INSTALLATION, IDENTIFIERS);

export function payload(overrides: Partial<LicencePayload> = {}): LicencePayload {
  return {
    format: 1,
    licenceId: '0199a0e0-0000-7000-8000-00000000b001',
    tenantId: '0199a0e0-0000-7000-8000-00000000c001',
    installationId: INSTALLATION,
    fingerprint: FINGERPRINT,
    plan: 'Standard',
    modules: ['POS', 'KDS', 'WAITER_APP', 'TABLE_TABLET', 'QR_MENU', 'PAGERS'],
    deviceLimits: { TABLE_TABLET: 20, PAGER: 10, WAITER_PHONE: 10, KDS: 4 },
    issuedAt: '2026-10-01T06:00:00.000Z',
    validUntil: '2026-10-31T06:00:00.000Z',
    graceDays: 7,
    state: 'ACTIVE',
    graceStartedAt: null,
    reason: null,
    ...overrides,
  };
}
