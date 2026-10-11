import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { open, seal } from '../auth/secret-box.js';
import type { PrismaService } from '../database/prisma.service.js';
import { backupKeyId } from './backup-file.js';

/**
 * The backup keys of the PCs this one was restored from (P7-10, DATA-009). A PC restored onto new
 * hardware keeps its own backup key for what it writes next (decision 536), so the archives the
 * old PC made would no longer open in the archive viewer, and that PC is gone. The restore keeps
 * the old keys in `system_meta`, sealed with a key derived from this PC's own backup key: a backup
 * of this PC carries them, but only for whoever holds this PC's key (its recovery key or the
 * vendor's escrow), who can read everything else in it already. They are only ever used to read.
 */
export const EARLIER_BACKUP_KEYS = 'backups.earlier_keys';
/** More PC moves than a restaurant makes; the oldest beyond this are dropped. */
const MAX_EARLIER_KEYS = 20;

const KeyRing = z.array(z.base64()).max(MAX_EARLIER_KEYS);

/** The key that seals the ring: not the backup key itself, which encrypts backups. */
function ringKey(ownKey: Buffer): Buffer {
  return createHmac('sha256', ownKey).update('rp-earlier-backup-keys').digest();
}

/** The earlier keys sealed with `ownKey`; none when absent or not sealed with it. */
export function openEarlierBackupKeys(ownKey: Buffer, sealed: string | null | undefined): Buffer[] {
  if (sealed === null || sealed === undefined) return [];
  try {
    const parsed = KeyRing.safeParse(JSON.parse(open(ringKey(ownKey), sealed).toString('utf8')));
    if (!parsed.success) return [];
    return parsed.data.map((key) => Buffer.from(key, 'base64')).filter((key) => key.length >= 32);
  } catch {
    return [];
  }
}

export function sealEarlierBackupKeys(ownKey: Buffer, keys: readonly Buffer[]): string {
  const ring = KeyRing.parse(keys.slice(0, MAX_EARLIER_KEYS).map((key) => key.toString('base64')));
  return seal(ringKey(ownKey), Buffer.from(JSON.stringify(ring), 'utf8'));
}

/**
 * What a restore leaves in the restored database: the backup's own key when it is not this PC's,
 * then the keys the backup's PC knew (sealed with `backupKey`), newest first, sealed with this
 * PC's `ownKey`. Null when there is nothing to keep (a backup this PC made, from before any move).
 */
export function carryEarlierBackupKeys(options: {
  readonly backupKey: Buffer;
  readonly ownKey: Buffer;
  readonly sealed: string | null | undefined;
}): string | null {
  const ownId = backupKeyId(options.ownKey);
  const keys = new Map<string, Buffer>();
  for (const key of [
    options.backupKey,
    ...openEarlierBackupKeys(options.backupKey, options.sealed),
  ]) {
    const id = backupKeyId(key);
    if (id !== ownId && !keys.has(id)) keys.set(id, key);
  }
  return keys.size === 0 ? null : sealEarlierBackupKeys(options.ownKey, [...keys.values()]);
}

/** The key that opens a file whose header names `keyId`: this PC's own, or an earlier PC's. */
export async function backupKeyFor(
  prisma: Pick<PrismaService, 'systemMeta'>,
  ownKey: Buffer,
  keyId: string,
): Promise<Buffer | undefined> {
  if (backupKeyId(ownKey) === keyId) return ownKey;
  const row = await prisma.systemMeta.findUnique({ where: { key: EARLIER_BACKUP_KEYS } });
  return openEarlierBackupKeys(ownKey, row?.value).find((key) => backupKeyId(key) === keyId);
}
