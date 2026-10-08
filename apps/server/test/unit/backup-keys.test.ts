import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { backupKeyId } from '../../src/backups/backup-file.js';
import {
  backupKeyFor,
  carryEarlierBackupKeys,
  EARLIER_BACKUP_KEYS,
  openEarlierBackupKeys,
  sealEarlierBackupKeys,
} from '../../src/backups/backup-keys.js';

const ids = (keys: readonly Buffer[]) => keys.map(backupKeyId);

/** `system_meta` with only the ring in it. */
function meta(value: string | null) {
  return {
    systemMeta: {
      findUnique: ({ where }: { where: { key: string } }) =>
        Promise.resolve(where.key === EARLIER_BACKUP_KEYS && value !== null ? { value } : null),
    },
  } as unknown as Parameters<typeof backupKeyFor>[0];
}

describe('[DATA-009] [DATA-004] the backup keys of the PCs this one was restored from', () => {
  const first = randomBytes(32);
  const second = randomBytes(32);
  const third = randomBytes(32);

  it('keeps the old PC’s key on a new PC, sealed with the new PC’s own key', () => {
    const carried = carryEarlierBackupKeys({ backupKey: first, ownKey: second, sealed: null });
    expect(carried).not.toBeNull();
    expect(ids(openEarlierBackupKeys(second, carried))).toEqual(ids([first]));
    // Without the new PC's key the ring tells nothing: the old key is not readable from it.
    expect(openEarlierBackupKeys(first, carried)).toEqual([]);
    expect(carried).not.toContain(first.toString('base64'));
  });

  it('passes on every earlier key at each move, newest first, once each', () => {
    const atSecond = carryEarlierBackupKeys({ backupKey: first, ownKey: second, sealed: null });
    const atThird = carryEarlierBackupKeys({ backupKey: second, ownKey: third, sealed: atSecond });
    expect(ids(openEarlierBackupKeys(third, atThird))).toEqual(ids([second, first]));
    // The third PC restores the second's backup again: nothing doubles.
    const again = carryEarlierBackupKeys({ backupKey: second, ownKey: third, sealed: atSecond });
    expect(ids(openEarlierBackupKeys(third, again))).toEqual(ids([second, first]));
  });

  it('keeps nothing for a backup this PC made, and never its own key', () => {
    expect(carryEarlierBackupKeys({ backupKey: first, ownKey: first, sealed: null })).toBeNull();
    // This PC goes back to its own backup from after an earlier move: the ring stays as it was.
    const ring = sealEarlierBackupKeys(second, [first]);
    const same = carryEarlierBackupKeys({ backupKey: second, ownKey: second, sealed: ring });
    expect(ids(openEarlierBackupKeys(second, same))).toEqual(ids([first]));
    // Back on the first PC's key (the first PC restores the second's backup): its own key drops.
    const back = carryEarlierBackupKeys({ backupKey: second, ownKey: first, sealed: ring });
    expect(ids(openEarlierBackupKeys(first, back))).toEqual(ids([second]));
  });

  it('ignores a ring it cannot open, and keeps at most twenty keys', () => {
    expect(openEarlierBackupKeys(first, 'v1.damaged')).toEqual([]);
    expect(openEarlierBackupKeys(first, sealEarlierBackupKeys(second, [third]))).toEqual([]);
    const many = Array.from({ length: 25 }, () => randomBytes(32));
    expect(openEarlierBackupKeys(first, sealEarlierBackupKeys(first, many))).toHaveLength(20);
  });

  it('finds the key a file names: this PC’s own, or an earlier one', async () => {
    const ring = sealEarlierBackupKeys(third, [second, first]);
    expect((await backupKeyFor(meta(ring), third, backupKeyId(third)))?.equals(third)).toBe(true);
    expect((await backupKeyFor(meta(ring), third, backupKeyId(first)))?.equals(first)).toBe(true);
    expect(await backupKeyFor(meta(ring), third, backupKeyId(randomBytes(32)))).toBeUndefined();
    expect(await backupKeyFor(meta(null), third, backupKeyId(first))).toBeUndefined();
  });
});
