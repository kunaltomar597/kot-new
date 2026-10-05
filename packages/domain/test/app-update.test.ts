import { describe, expect, it } from 'vitest';
import { mayApplyAppUpdate, otaUpdateVerdict } from '../src/app-update.js';

const server = (current: string, oldest: string) => ({ current, oldest });

describe('[UPD-001] [UPD-006] an over-the-air update and the server it talks to', () => {
  it('applies an update speaking the server API or the one before it', () => {
    expect(otaUpdateVerdict(server('1.4', '1.3'), '1.4')).toBe('APPLY');
    expect(otaUpdateVerdict(server('1.4', '1.3'), '1.3')).toBe('APPLY');
    expect(otaUpdateVerdict(server('1.0', '1.0'), '1.0')).toBe('APPLY');
  });

  it('waits for the restaurant PC when the update speaks a newer API', () => {
    expect(otaUpdateVerdict(server('1.4', '1.3'), '1.5')).toBe('WAIT_FOR_SERVER');
    expect(otaUpdateVerdict(server('1.4', '1.3'), '2.0')).toBe('WAIT_FOR_SERVER');
  });

  it('never takes an update the server no longer serves', () => {
    expect(otaUpdateVerdict(server('1.4', '1.3'), '1.2')).toBe('NOT_SERVED');
    expect(otaUpdateVerdict(server('2.0', '2.0'), '1.9')).toBe('NOT_SERVED');
  });

  it('follows the range the server says, not one it works out', () => {
    // A server may serve a narrower range than N-1 (a new major serves only itself).
    expect(otaUpdateVerdict(server('1.4', '1.4'), '1.3')).toBe('NOT_SERVED');
  });

  it('does not take an update when either API is unknown', () => {
    expect(otaUpdateVerdict(undefined, '1.4')).toBe('UNKNOWN');
    expect(otaUpdateVerdict(server('1.4', '1.3'), undefined)).toBe('UNKNOWN');
    expect(otaUpdateVerdict(server('1.4', '1.3'), '1.4.0')).toBe('UNKNOWN');
    expect(otaUpdateVerdict(server('v1', '1.3'), '1.4')).toBe('UNKNOWN');
    expect(otaUpdateVerdict(server('1.4', ''), '1.4')).toBe('UNKNOWN');
  });
});

describe('[UPD-001] when a downloaded update restarts the app', () => {
  it('waits while the device is in use', () => {
    expect(mayApplyAppUpdate({ refused: false, busy: true })).toBe(false);
    expect(mayApplyAppUpdate({ refused: false, busy: false })).toBe(true);
  });

  it('switches at once when the server refuses the app as it is', () => {
    expect(mayApplyAppUpdate({ refused: true, busy: true })).toBe(true);
  });
});
