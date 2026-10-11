import { statfs } from 'node:fs/promises';

/** Size and free space of a drive, in bytes. */
export interface DriveSpace {
  readonly totalBytes: number;
  readonly freeBytes: number;
}

/**
 * Size and free space of the data drive (ONB-002, DATA-006): the drive holding `dataDir`, with
 * the space this process may use as free. Null when it cannot be read.
 */
export async function readDataDrive(dataDir: string): Promise<DriveSpace | null> {
  try {
    const stats = await statfs(dataDir);
    return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
  } catch {
    return null;
  }
}
