import { describe, expect, it } from 'vitest';
import { clockSkewed, guardedNow } from '../src/clock.js';
import { evaluateLicence, type LicenceInput } from '../src/evaluate.js';
import {
  fingerprintHash,
  fingerprintMatchCount,
  fingerprintOf,
  isLicensedPc,
} from '../src/fingerprint.js';
import {
  reactivationCode,
  reactivationSecretOf,
  readReactivationCode,
} from '../src/reactivation.js';
import { keyIdOf, signLicence, verifyLicence } from '../src/signing.js';
import { FINGERPRINT, IDENTIFIERS, INSTALLATION, payload, vendorKeys } from './fixtures.js';

const vendor = vendorKeys();
const signed = (overrides = {}) => signLicence(payload(overrides), vendor.privateKey, vendor.spki);
const verified = (overrides = {}) => verifyLicence(signed(overrides), [vendor.spki]);

describe('[LIC-001] [LIC-003] licence files', () => {
  it('accepts a file signed by a vendor key built into the software', () => {
    const result = verified();
    expect(result).toMatchObject({ ok: true, payload: { plan: 'Standard', state: 'ACTIVE' } });
    // Keys are rotated by adding the new one: either verifies.
    expect(verifyLicence(signed(), [vendorKeys().spki, vendor.spki]).ok).toBe(true);
  });

  it('refuses a missing, unknown-key, tampered or malformed file', () => {
    expect(verifyLicence(undefined, [vendor.spki])).toEqual({ ok: false, problem: 'MISSING' });
    expect(verifyLicence(signed(), [vendorKeys().spki])).toEqual({
      ok: false,
      problem: 'UNKNOWN_KEY',
    });
    const file = signed();
    const raised = {
      ...file,
      payload: file.payload.replace('"TABLE_TABLET":20', '"TABLE_TABLET":99'),
    };
    expect(verifyLicence(raised, [vendor.spki])).toEqual({ ok: false, problem: 'TAMPERED' });
    expect(verifyLicence({ ...file, signature: 'AAAA' }, [vendor.spki])).toEqual({
      ok: false,
      problem: 'TAMPERED',
    });
    // Signed, but not a licence (an older format, say).
    const odd = signLicence(payload(), vendor.privateKey, vendor.spki);
    const reSigned = {
      ...odd,
      payload: '{"format":2}',
      signature: signLicence(payload(), vendor.privateKey, vendor.spki).signature,
    };
    expect(verifyLicence(reSigned, [vendor.spki]).ok).toBe(false);
    expect(keyIdOf(vendor.spki)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('[LIC-004] the PC fingerprint', () => {
  it('keeps hashes tied to the installation, never the identifiers, and ignores placeholders', () => {
    expect(FINGERPRINT.every((entry) => entry !== null && /^[0-9a-f]{64}$/.test(entry))).toBe(true);
    expect(JSON.stringify(FINGERPRINT)).not.toContain('BSN-1234');
    expect(fingerprintOf('0199a0e0-0000-7000-8000-00000000a002', IDENTIFIERS)).not.toEqual(
      FINGERPRINT,
    );
    expect(fingerprintHash(INSTALLATION, 'BOARD_SERIAL', 'To be filled by O.E.M.')).toBeNull();
    expect(fingerprintHash(INSTALLATION, 'DISK_SERIAL', '  ')).toBeNull();
    expect(fingerprintHash(INSTALLATION, 'CPU_ID', 'bfebfbff000906ea')).toBe(FINGERPRINT[4]);
  });

  it('tolerates two changed identifiers, not three', () => {
    const newDisk = fingerprintOf(INSTALLATION, {
      ...IDENTIFIERS,
      DISK_SERIAL: 'SSD-9',
      CPU_ID: null,
    });
    expect(fingerprintMatchCount(FINGERPRINT, newDisk)).toBe(3);
    expect(isLicensedPc(FINGERPRINT, newDisk)).toBe(true);
    const otherPc = fingerprintOf(INSTALLATION, {
      ...IDENTIFIERS,
      DISK_SERIAL: 'x',
      CPU_ID: 'y',
      BIOS_UUID: 'z',
    });
    expect(isLicensedPc(FINGERPRINT, otherPc)).toBe(false);
    // Identifiers the PC could not read never count, even when both sides lack them.
    const blank = [null, null, null, null, null];
    expect(isLicensedPc(blank, blank)).toBe(false);
  });
});

describe('[LIC-005] [LIC-002] the state the restaurant experiences', () => {
  // 2026-10-10 14:30 IST, in the middle of service.
  const DURING_SERVICE = new Date('2026-10-10T09:00:00.000Z');
  const input = (over: Partial<LicenceInput> = {}): LicenceInput => ({
    file: verified(),
    installationId: INSTALLATION,
    fingerprint: FINGERPRINT,
    now: DURING_SERVICE,
    restrictionDecidedAt: undefined,
    ...over,
  });

  it('is fully active with a valid licence, with a reminder when payment is due', () => {
    const active = evaluateLicence(input());
    expect(active).toMatchObject({ state: 'ACTIVE', problem: null, restrictedFrom: null });
    expect(active.capabilities.createOrders).toBe(true);
    const due = evaluateLicence(input({ file: verified({ state: 'PAYMENT_DUE' }) }));
    expect(due.state).toBe('PAYMENT_DUE');
    expect(due.capabilities).toMatchObject({ createOrders: true, showPaymentReminder: true });
  });

  it('counts the days of grace left, and restricts when grace is over', () => {
    const grace = evaluateLicence(
      input({ file: verified({ state: 'GRACE', graceStartedAt: '2026-10-05T09:00:00.000Z' }) }),
    );
    expect(grace).toMatchObject({ state: 'GRACE', daysLeft: 2 });
    expect(grace.capabilities.showGraceBanner).toBe(true);
    const over = evaluateLicence(
      input({ file: verified({ state: 'GRACE', graceStartedAt: '2026-10-01T09:00:00.000Z' }) }),
    );
    expect(over).toMatchObject({ recorded: 'RESTRICTED', problem: 'GRACE_ENDED' });
  });

  it('[LIC-005] never restricts mid-service: from the start of the next business day', () => {
    const expired = evaluateLicence(
      input({ file: verified({ validUntil: '2026-10-10T06:00:00.000Z' }) }),
    );
    // Decided at 14:30 IST on the 10th: applies at 04:00 IST on the 11th.
    expect(expired).toMatchObject({
      recorded: 'RESTRICTED',
      state: 'GRACE',
      problem: 'EXPIRED',
      daysLeft: 1,
    });
    expect(expired.restrictedFrom?.toISOString()).toBe('2026-10-10T22:30:00.000Z');
    expect(expired.restrictionDecidedAt).toEqual(DURING_SERVICE);
    expect(expired.capabilities.createOrders).toBe(true);
    // The next morning, with the decision saved: applied.
    const morning = evaluateLicence(
      input({
        file: verified({ validUntil: '2026-10-10T06:00:00.000Z' }),
        now: new Date('2026-10-11T00:00:00.000Z'),
        restrictionDecidedAt: DURING_SERVICE,
      }),
    );
    expect(morning).toMatchObject({ state: 'RESTRICTED', daysLeft: 0 });
    expect(morning.capabilities).toMatchObject({
      openNewTableSessions: false,
      createOrders: false,
      sendKots: false,
      billOpenTables: true,
      print: true,
      viewReports: true,
      exportData: true,
      backups: true,
    });
  });

  it('[LIC-003] restricts a missing or tampered file, another installation’s, or another PC', () => {
    expect(evaluateLicence(input({ file: { ok: false, problem: 'MISSING' } }))).toMatchObject({
      recorded: 'RESTRICTED',
      problem: 'MISSING',
      payload: null,
    });
    expect(
      evaluateLicence(input({ installationId: '0199a0e0-0000-7000-8000-00000000a009' })).problem,
    ).toBe('OTHER_INSTALLATION');
    const moved = fingerprintOf(INSTALLATION, { MACHINE_ID: 'new', BOARD_SERIAL: 'new' });
    expect(evaluateLicence(input({ fingerprint: moved })).problem).toBe('OTHER_PC');
  });

  it('follows the vendor: restricted or terminated, data never withheld', () => {
    const terminated = evaluateLicence(
      input({ file: verified({ state: 'TERMINATED' }), restrictionDecidedAt: new Date(0) }),
    );
    expect(terminated).toMatchObject({ recorded: 'TERMINATED', state: 'TERMINATED' });
    expect(terminated.capabilities.exportData).toBe(true);
    expect(evaluateLicence(input({ file: verified({ state: 'RESTRICTED' }) })).problem).toBe(
      'VENDOR',
    );
  });

  it('[LIC-006] is active again until the day of an offline reactivation code', () => {
    const until = new Date('2026-10-20T22:30:00.000Z');
    const expiredFile = verified({ validUntil: '2026-10-01T06:00:00.000Z' });
    expect(evaluateLicence(input({ file: expiredFile, reactivatedUntil: until }))).toMatchObject({
      state: 'ACTIVE',
      problem: null,
    });
    // Not for a terminated contract, nor a file that cannot be trusted, nor once its day is past.
    expect(
      evaluateLicence(input({ file: verified({ state: 'TERMINATED' }), reactivatedUntil: until }))
        .recorded,
    ).toBe('TERMINATED');
    expect(
      evaluateLicence(input({ file: { ok: false, problem: 'TAMPERED' }, reactivatedUntil: until }))
        .recorded,
    ).toBe('RESTRICTED');
    expect(
      evaluateLicence(
        input({
          file: expiredFile,
          reactivatedUntil: until,
          now: new Date('2026-10-21T00:00:00Z'),
        }),
      ).recorded,
    ).toBe('RESTRICTED');
  });
});

describe('[LIC-006] offline reactivation codes', () => {
  const secret = reactivationSecretOf(Buffer.from('vendor master key for the test'), INSTALLATION);

  it('carries the day and a counter, read back only by its installation', () => {
    const code = reactivationCode(secret, INSTALLATION, '2026-11-15', 3);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(readReactivationCode(code, secret, INSTALLATION)).toEqual({
      validUntil: '2026-11-15',
      counter: 3,
    });
    // As typed by a person: lower case, spaces, O for 0.
    const typed = code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o');
    expect(readReactivationCode(typed, secret, INSTALLATION)?.validUntil).toBe('2026-11-15');
    expect(
      readReactivationCode(code, secret, '0199a0e0-0000-7000-8000-00000000a002'),
    ).toBeUndefined();
    const other = reactivationSecretOf(Buffer.from('another key'), INSTALLATION);
    expect(readReactivationCode(code, other, INSTALLATION)).toBeUndefined();
  });

  it('refuses a mistyped code', () => {
    const code = reactivationCode(secret, INSTALLATION, '2026-11-15', 3);
    const typo = `${code.slice(0, 5)}${code[5] === 'A' ? 'B' : 'A'}${code.slice(6)}`;
    expect(readReactivationCode(typo, secret, INSTALLATION)).toBeUndefined();
    expect(readReactivationCode('ABCD-EFGH', secret, INSTALLATION)).toBeUndefined();
    expect(readReactivationCode('ABCD-EFGH-JKMN-PQR!', secret, INSTALLATION)).toBeUndefined();
    expect(() => reactivationCode(secret, INSTALLATION, '2026-11-15', 256)).toThrow(RangeError);
    expect(() => reactivationCode(secret, INSTALLATION, 'soon', 1)).toThrow(RangeError);
  });
});

describe('[LIC-007] the clock guard', () => {
  it('never judges by a time earlier than the last seen, and reports a clock set back', () => {
    const lastSeen = new Date('2026-10-10T09:00:00.000Z');
    expect(guardedNow(new Date('2026-10-10T09:02:00.000Z'), lastSeen)).toEqual({
      now: new Date('2026-10-10T09:02:00.000Z'),
      rolledBack: false,
    });
    // A minute back: an NTP correction, judged by the last seen.
    expect(guardedNow(new Date('2026-10-10T08:59:00.000Z'), lastSeen)).toEqual({
      now: lastSeen,
      rolledBack: false,
    });
    expect(guardedNow(new Date('2026-10-01T09:00:00.000Z'), lastSeen)).toEqual({
      now: lastSeen,
      rolledBack: true,
    });
    expect(guardedNow(lastSeen, undefined).rolledBack).toBe(false);
    expect(clockSkewed(lastSeen, new Date('2026-10-10T09:05:00.000Z'))).toBe(false);
    expect(clockSkewed(lastSeen, new Date('2026-10-10T09:15:00.000Z'))).toBe(true);
  });
});
