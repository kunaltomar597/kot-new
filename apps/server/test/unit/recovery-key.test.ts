import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { formatRecoveryKey, parseRecoveryKey } from '../../src/backups/recovery-key.js';

describe('[DATA-004] the backup recovery key', () => {
  it('writes the key in groups and reads it back, however it is typed', () => {
    const key = randomBytes(32);
    const written = formatRecoveryKey(key);
    expect(written).toMatch(/^RPK1(-[A-Z2-7]{5}){10}-[A-Z2-7]{5}$/);
    expect(parseRecoveryKey(written)?.equals(key)).toBe(true);
    const typed = written.toLowerCase().replaceAll('-', ' ');
    expect(parseRecoveryKey(typed)?.equals(key)).toBe(true);
  });

  it('finds a mistyped character before any backup is tried', () => {
    const written = formatRecoveryKey(randomBytes(32));
    const last = written.at(-1) === 'A' ? 'B' : 'A';
    expect(parseRecoveryKey(`${written.slice(0, -1)}${last}`)).toBeUndefined();
    const groups = written.split('-');
    [groups[2], groups[3]] = [groups[3]!, groups[2]!];
    expect(parseRecoveryKey(groups.join('-'))).toBeUndefined();
    expect(parseRecoveryKey('RPK1-0000')).toBeUndefined();
    expect(parseRecoveryKey('not a key')).toBeUndefined();
  });
});
