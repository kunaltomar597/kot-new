import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { STORAGE_CATEGORIES, type StorageCategory } from '@rp/contracts';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';

/**
 * The folders under the data folder that hold files of each category (DATA-001): photos
 * (P1-04), the service's log files (P0-16) and local backups (P7-05).
 */
export const STORAGE_FOLDERS = { PHOTOS: 'photos', LOGS: 'logs', BACKUPS: 'backups' } as const;

/** Categories are measured at most this often: walking the photo folder takes a moment. */
export const STORAGE_MEASURE_MS = 60_000;

const STAT_BATCH = 64;

export interface CategoryUsage {
  readonly category: StorageCategory;
  /** Null when the category could not be measured. */
  readonly bytes: number | null;
}

/**
 * Bytes of every file in a folder and below it: 0 when the folder does not exist yet, null when
 * it cannot be read.
 */
export async function folderBytes(path: string): Promise<number | null> {
  let entries;
  try {
    entries = await readdir(path, { recursive: true, withFileTypes: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : null;
  }
  const files = entries.filter((entry) => entry.isFile());
  let total = 0;
  for (let start = 0; start < files.length; start += STAT_BATCH) {
    const sizes = await Promise.all(
      files.slice(start, start + STAT_BATCH).map((entry) =>
        lstat(join(entry.parentPath, entry.name)).then(
          (stats) => stats.size,
          // Removed while it was counted.
          () => 0,
        ),
      ),
    );
    total += sizes.reduce((sum, size) => sum + size, 0);
  }
  return total;
}

/**
 * What uses the data drive, by category (DATA-006): the database's audit trail, the rest of the
 * database (orders, bills, payments and the other business records), photos, logs and backups.
 */
@Injectable()
export class StorageUsage {
  private last: { readonly at: number; readonly usage: Promise<CategoryUsage[]> } | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  /** The latest measurement, taken again when it is older than a minute. */
  categories(now = Date.now()): Promise<CategoryUsage[]> {
    if (this.last === undefined || now - this.last.at >= STORAGE_MEASURE_MS) {
      this.last = { at: now, usage: this.measure() };
    }
    return this.last.usage;
  }

  private async measure(): Promise<CategoryUsage[]> {
    const folder = (name: string) => folderBytes(join(this.config.dataDir, name));
    const [database, photos, logs, backups] = await Promise.all([
      this.database(),
      folder(STORAGE_FOLDERS.PHOTOS),
      folder(STORAGE_FOLDERS.LOGS),
      folder(STORAGE_FOLDERS.BACKUPS),
    ]);
    const bytes: Record<StorageCategory, number | null> = {
      TRANSACTIONS: database === null ? null : Math.max(database.total - database.audit, 0),
      AUDIT: database?.audit ?? null,
      PHOTOS: photos,
      LOGS: logs,
      BACKUPS: backups,
    };
    return STORAGE_CATEGORIES.map((category) => ({ category, bytes: bytes[category] }));
  }

  private async database(): Promise<{ total: number; audit: number } | null> {
    try {
      const [row] = await this.prisma.$queryRaw<{ total: bigint; audit: bigint }[]>`
        SELECT pg_database_size(current_database()) AS total,
               pg_total_relation_size('audit_log') AS audit`;
      return row === undefined ? null : { total: Number(row.total), audit: Number(row.audit) };
    } catch {
      return null;
    }
  }
}
