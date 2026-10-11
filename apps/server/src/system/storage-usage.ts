import { lstat, readdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { StorageCategory, StorageLevel } from '@rp/contracts';

/** The bytes of the files under a folder, or null when it does not exist or cannot be read. */
export async function directoryBytes(path: string): Promise<number | null> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return null;
  }
  let total = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      total += (await directoryBytes(child)) ?? 0;
    } else if (entry.isFile()) {
      try {
        total += (await lstat(child)).size;
      } catch {
        // Removed while counting: it no longer takes space.
      }
    }
  }
  return total;
}

export interface DriveSpace {
  readonly totalBytes: number;
  readonly freeBytes: number;
}

/** The size and free space of the drive a folder is on; null when it cannot be read. */
export async function driveSpace(path: string): Promise<DriveSpace | null> {
  try {
    const stats = await statfs(path);
    return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
  } catch {
    return null;
  }
}

/** The whole-percent use of a drive. */
export function usedPercent(space: DriveSpace): number {
  if (space.totalBytes <= 0) return 0;
  return Math.min(100, Math.round(((space.totalBytes - space.freeBytes) / space.totalBytes) * 100));
}

/** OK, WARNING or CRITICAL against the two thresholds (DATA-006); UNKNOWN without a reading. */
export function storageLevel(
  percent: number | null,
  warnPercent: number,
  criticalPercent: number,
): StorageLevel {
  if (percent === null) return 'UNKNOWN';
  if (percent >= criticalPercent) return 'CRITICAL';
  return percent >= warnPercent ? 'WARNING' : 'OK';
}

/** The folders under the data directory each category lives in (none for the database parts). */
export const CATEGORY_FOLDERS: Readonly<Partial<Record<StorageCategory, string>>> = {
  PHOTOS: 'photos',
  LOGS: 'logs',
  BACKUPS: 'backups',
};
