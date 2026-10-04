import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/**
 * The Owner's permission for the uninstaller to delete the data (NFR-I02, P0-16c). Uninstalling
 * keeps the folder on the data drive, so a reinstall carries on where it left off. The uninstaller
 * deletes it only while this permission holds: the Owner gives it on the System page with their
 * password and second factor (AUTH-006), it is audited, and it lasts `DATA_DELETION_MINUTES`.
 *
 * The server writes it to `<dataDir>/run/data-deletion.json`; `setup-cli data-deletion` reads it
 * for the uninstall script. It keeps the data from being deleted by mistake or by someone without
 * the Owner's secrets; a Windows administrator could delete the folder by hand in any case.
 */

export const DATA_DELETION_MINUTES = 30;

/** A permission dated this far ahead of the PC's clock was not written by the server. */
const CLOCK_SKEW_MS = 60_000;

export const DataDeletionPermission = z.object({
  format: z.literal(1),
  allowedAt: z.iso.datetime(),
  until: z.iso.datetime(),
  allowedBy: z.object({ staffId: z.string().min(1), deviceId: z.string().nullable() }),
});
export type DataDeletionPermission = z.infer<typeof DataDeletionPermission>;

export function dataDeletionPath(dataDir: string): string {
  return join(dataDir, 'run', 'data-deletion.json');
}

/** The permission from `now` for `DATA_DELETION_MINUTES`. */
export function dataDeletionPermission(
  allowedBy: DataDeletionPermission['allowedBy'],
  now: Date,
): DataDeletionPermission {
  return {
    format: 1,
    allowedAt: now.toISOString(),
    until: new Date(now.getTime() + DATA_DELETION_MINUTES * 60_000).toISOString(),
    allowedBy,
  };
}

/**
 * Until when the permission holds at `now`, or null: none, expired, or not one the server wrote
 * (longer than `DATA_DELETION_MINUTES`, or dated in the future).
 */
export function dataDeletionAllowedUntil(
  permission: DataDeletionPermission | null,
  now: Date,
): Date | null {
  if (permission === null) return null;
  const allowedAt = Date.parse(permission.allowedAt);
  const until = Date.parse(permission.until);
  if (allowedAt > now.getTime() + CLOCK_SKEW_MS) return null;
  if (until - allowedAt > DATA_DELETION_MINUTES * 60_000 || until <= allowedAt) return null;
  return until > now.getTime() ? new Date(until) : null;
}

/** Written beside it, then renamed over it, so the uninstaller never reads half a file. */
export async function saveDataDeletionPermission(
  dataDir: string,
  permission: DataDeletionPermission,
): Promise<void> {
  const path = dataDeletionPath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.new`, `${JSON.stringify(DataDeletionPermission.parse(permission))}\n`);
  await rename(`${path}.new`, path);
}

export async function removeDataDeletionPermission(dataDir: string): Promise<void> {
  await rm(dataDeletionPath(dataDir), { force: true });
}

/** The permission written last, or null when there is none or it cannot be read. */
export async function readDataDeletionPermission(
  dataDir: string,
): Promise<DataDeletionPermission | null> {
  let text: string;
  try {
    text = await readFile(dataDeletionPath(dataDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed = DataDeletionPermission.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
