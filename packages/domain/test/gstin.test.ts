import { describe, expect, it } from 'vitest';
import {
  GST_STATE_CODES,
  gstinCheckCharacter,
  gstinProblem,
  isValidGstin,
  normaliseGstin,
} from '../src/gstin.js';

// GSTINs published on invoices and in the GST portal's documentation.
const VALID = ['27AAPFU0939F1ZV', '29AAGCB7383J1Z4', '33AAACH7409R1Z8'];

describe('[BILL-002] [ONB-004] GSTIN validation', () => {
  it.each(VALID)('accepts %s', (gstin) => {
    expect(isValidGstin(gstin)).toBe(true);
    expect(gstinCheckCharacter(gstin.slice(0, 14))).toBe(gstin.charAt(14));
  });

  it('catches a mistyped character through the checksum', () => {
    expect(gstinProblem('27AAPFU0939F1ZW')).toBe('CHECKSUM');
    expect(gstinProblem('27AAPFU0938F1ZV')).toBe('CHECKSUM');
    // Swapping two neighbours is caught too (the weights differ).
    expect(gstinProblem('27AAPFU0993F1ZV')).toBe('CHECKSUM');
  });

  it('refuses the wrong shape or an unknown state code', () => {
    for (const bad of [
      '',
      '27AAPFU0939F1Z',
      '27AAPFU0939F1ZVX',
      '27aapfu0939f1zv',
      '27AAPFU0939F1YV',
      '270APFU0939F1ZV',
    ]) {
      expect(gstinProblem(bad), bad).toBe('FORMAT');
    }
    const unknownState = `99AAPFU0939F1Z`;
    expect(gstinProblem(unknownState + gstinCheckCharacter(unknownState))).toBe('STATE_CODE');
  });

  it('normalises what people type', () => {
    expect(normaliseGstin(' 27aapfu 0939f1zv ')).toBe('27AAPFU0939F1ZV');
  });

  it('knows every state and union territory, two digits each', () => {
    expect(GST_STATE_CODES['27']).toBe('Maharashtra');
    expect(GST_STATE_CODES['29']).toBe('Karnataka');
    expect(GST_STATE_CODES['36']).toBe('Telangana');
    for (const code of Object.keys(GST_STATE_CODES)) expect(code).toMatch(/^\d{2}$/);
  });
});
