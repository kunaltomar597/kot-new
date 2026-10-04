import { describe, expect, it } from 'vitest';
import { indianMobile, maskPhone, nextDigitalBillAttempt } from '../src/digital-bill.js';

describe('[BILL-012] the diner’s number for a digital bill', () => {
  it('reads Indian mobile numbers however they are written', () => {
    for (const written of [
      '9876543210',
      '98765 43210',
      '+91 98765 43210',
      '+91-98765-43210',
      '919876543210',
      '098765 43210',
      '(+91) 98765.43210',
    ]) {
      expect(indianMobile(written), written).toBe('+919876543210');
    }
  });

  it('refuses landlines, short numbers and other countries', () => {
    for (const written of ['022 2345 6789', '12345', '+44 7700 900123', '5876543210', 'call me']) {
      expect(indianMobile(written), written).toBeUndefined();
    }
  });

  it('[BILL-011] shows only the last four digits', () => {
    expect(maskPhone('+919876543210')).toBe('+91 ******3210');
    expect(maskPhone('9876543210')).toBe('******3210');
  });
});

describe('[BILL-012] trying a digital bill again', () => {
  const queued = new Date('2026-10-04T10:00:00Z');

  it('waits longer after each failed try', () => {
    const at = (attempts: number, now: Date) =>
      nextDigitalBillAttempt(queued, attempts, now)?.toISOString();
    expect(at(1, queued)).toBe('2026-10-04T10:01:00.000Z');
    expect(at(2, queued)).toBe('2026-10-04T10:05:00.000Z');
    expect(at(4, queued)).toBe('2026-10-04T11:00:00.000Z');
    expect(at(9, queued)).toBe('2026-10-04T13:00:00.000Z');
  });

  it('gives up when the next try would be more than a day after the bill was queued', () => {
    expect(nextDigitalBillAttempt(queued, 9, new Date('2026-10-05T07:01:00Z'))).toBeUndefined();
    expect(nextDigitalBillAttempt(queued, 9, new Date('2026-10-05T06:59:00Z'))).toBeDefined();
  });
});
