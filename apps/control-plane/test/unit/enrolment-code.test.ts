import { EnrolmentCode } from '@rp/contracts/control-plane';
import { describe, expect, it } from 'vitest';
import {
  generateEnrolmentCode,
  hashEnrolmentCode,
} from '../../src/installations/enrolment-code.js';

describe('[SEC-002] [ONB-003] enrolment codes (ADR-0012)', () => {
  it('are 16 characters without look-alikes in four groups, and differ every time', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateEnrolmentCode()));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(EnrolmentCode.safeParse(code).success, code).toBe(true);
  });

  it('are stored as a SHA-256 digest, never as the code', () => {
    const code = generateEnrolmentCode();
    expect(hashEnrolmentCode(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashEnrolmentCode(code)).not.toContain(code);
    expect(hashEnrolmentCode(code)).toBe(hashEnrolmentCode(code));
  });
});
