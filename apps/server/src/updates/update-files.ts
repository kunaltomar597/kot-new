import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/**
 * The hand-off between the server's update agent and the updater on the restaurant PC (P7-04c).
 * The server runs as `NT SERVICE\RPServer`, which cannot install software. It downloads and checks
 * the installer, makes the backup, then writes the request in `<data>/run`; the watchdog
 * (LocalSystem) sees it and starts the updater's scheduled task, which runs as SYSTEM
 * (`infra/installer/windows`, `Update-RestaurantPlatform.ps1`).
 *
 * The updater trusts nothing the server's account wrote: it checks the installer's hash and
 * signature again in a folder only administrators can write, and it only reads in the data folder
 * (the server's account could turn a folder there into a link elsewhere). It writes its outcome in
 * `%ProgramData%\RestaurantPlatform`, which administrators write and the server reads.
 */

/** Installers are named by their version, as the CI job names them. */
export function installerFileName(version: string): string {
  return `RestaurantPlatform-Setup-${version}.exe`;
}

const SemVerText = z
  .string()
  .max(64)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/);
const InstallerName = z.string().regex(/^RestaurantPlatform-Setup-[0-9A-Za-z.-]{5,64}\.exe$/);

export const UpdateRequestFile = z.object({
  format: z.literal(1),
  requestId: z.uuid(),
  /** The version to install, newer than `previousVersion`. */
  version: SemVerText,
  previousVersion: z.string().min(1).max(64),
  /** In `<data>/updates`. */
  fileName: InstallerName,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.int().positive(),
  securityCritical: z.boolean(),
  /** The maintenance window, or a manager's "Install now". */
  trigger: z.enum(['WINDOW', 'APPROVED']),
  approvedByStaffId: z.uuid().nullable(),
  /** The full backup made before it (UPD-005). */
  backupFileName: z.string().max(200).nullable(),
  requestedAt: z.iso.datetime(),
});
export type UpdateRequestFile = z.infer<typeof UpdateRequestFile>;

export const UpdateOutcomeFile = z.object({
  format: z.literal(1),
  requestId: z.string().max(64),
  version: z.string().max(64),
  previousVersion: z.string().max(64).nullable(),
  /**
   * RUNNING: the updater took the request and is at work. INSTALLED: the new version runs and
   * passed its health check. ROLLED_BACK: it failed, and the previous version runs again with the
   * database from before the update. FAILED: the update did not happen (nothing changed), or
   * going back failed too.
   */
  outcome: z.enum(['RUNNING', 'INSTALLED', 'ROLLED_BACK', 'FAILED']),
  /** Why, in plain words; null when it worked. */
  error: z.string().max(1_000).nullable(),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }),
  /** The updater's log, for support. */
  logFile: z.string().max(500).nullable(),
});
export type UpdateOutcomeFile = z.infer<typeof UpdateOutcomeFile>;

export const updatesDir = (dataDir: string) => join(dataDir, 'updates');
export const updateRequestPath = (dataDir: string) => join(dataDir, 'run', 'update-request.json');
/** In the installation file's folder, `%ProgramData%\RestaurantPlatform`. */
export const updateOutcomePath = (programDataDir: string) =>
  join(programDataDir, 'update-outcome.json');

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    // Windows PowerShell 5.1 may start its UTF-8 with a byte order mark.
    const parsed = schema.safeParse(JSON.parse(text.replace(/^\uFEFF/, '')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Written beside it, then renamed, so the watchdog never reads half a request. */
export async function writeUpdateRequest(
  dataDir: string,
  request: UpdateRequestFile,
): Promise<void> {
  const path = updateRequestPath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.new`, JSON.stringify(UpdateRequestFile.parse(request)));
  await rename(`${path}.new`, path);
}

export function readUpdateRequest(dataDir: string): Promise<UpdateRequestFile | null> {
  return readJson(updateRequestPath(dataDir), UpdateRequestFile);
}

export async function removeUpdateRequest(dataDir: string): Promise<void> {
  await rm(updateRequestPath(dataDir), { force: true });
}

export function readUpdateOutcome(programDataDir: string): Promise<UpdateOutcomeFile | null> {
  return readJson(updateOutcomePath(programDataDir), UpdateOutcomeFile);
}
