import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { WritableSecretStore } from '../auth/secret-store.js';
import { restoreBackup } from './restore.js';

/**
 * "Restore" on the System page (DATA-004, P7-05b): the server checks the request, writes it here
 * and restarts; the restore runs before the server starts again, when nothing uses the database.
 * The Windows service runs `restore-cli pending` before starting the server (P0-16); a server
 * given `RP_ADMIN_DATABASE_URL` runs it itself at start-up.
 */

export const RestoreRequest = z.object({
  /** The backup file, already resolved to its full path by the server. */
  path: z.string().min(1),
  requestedAt: z.iso.datetime(),
  requestedBy: z.object({ staffId: z.string(), deviceId: z.string().nullable() }),
});
export type RestoreRequest = z.infer<typeof RestoreRequest>;

/** How the last restore attempt ended, kept outside the database (which it may not reach). */
export const RestoreOutcome = z.object({
  at: z.iso.datetime(),
  ok: z.boolean(),
  /** What went wrong, in plain words; null when it worked. */
  error: z.string().nullable(),
  backupCreatedAt: z.iso.datetime().nullable(),
  /** The database as it was before, kept to go back to. */
  previousDatabase: z.string().nullable(),
  durationMs: z.int().nonnegative().nullable(),
});
export type RestoreOutcome = z.infer<typeof RestoreOutcome>;

const folderOf = (dataDir: string) => join(dataDir, 'backups');
export const requestPath = (dataDir: string) => join(folderOf(dataDir), 'restore-request.json');
export const outcomePath = (dataDir: string) => join(folderOf(dataDir), 'restore-outcome.json');

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function saveRestoreRequest(dataDir: string, request: RestoreRequest): Promise<void> {
  await mkdir(folderOf(dataDir), { recursive: true, mode: 0o700 });
  await writeFile(requestPath(dataDir), JSON.stringify(request), { mode: 0o600 });
}

export function readRestoreRequest(dataDir: string): Promise<RestoreRequest | null> {
  return readJson(requestPath(dataDir), RestoreRequest);
}

export function readRestoreOutcome(dataDir: string): Promise<RestoreOutcome | null> {
  return readJson(outcomePath(dataDir), RestoreOutcome);
}

export interface PendingRestoreOptions {
  readonly dataDir: string;
  readonly databaseUrl: string;
  readonly adminUrl: string;
  readonly pgBin: string | undefined;
  readonly secrets: WritableSecretStore;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

/**
 * Runs a waiting restore request, once: the request is removed before the restore starts, so a
 * restore that fails (or crashes the PC) is not tried again on every start. The outcome is
 * written for the System page.
 */
export async function runPendingRestore(
  options: PendingRestoreOptions,
): Promise<RestoreOutcome | null> {
  const request = await readRestoreRequest(options.dataDir);
  await rm(requestPath(options.dataDir), { force: true });
  if (request === null) return null;
  const now = options.now ?? (() => new Date());
  const started = now();
  let outcome: RestoreOutcome;
  try {
    const result = await restoreBackup({
      file: request.path,
      key: await options.secrets.get('backup-key'),
      databaseUrl: options.databaseUrl,
      adminUrl: options.adminUrl,
      dataDir: options.dataDir,
      secrets: options.secrets,
      pgBin: options.pgBin,
      requestedBy: request.requestedBy,
      now,
      ...(options.log !== undefined && { log: options.log }),
    });
    outcome = {
      at: result.finishedAt.toISOString(),
      ok: true,
      error: null,
      backupCreatedAt: result.info.createdAt,
      previousDatabase: result.previousDatabase,
      durationMs: result.finishedAt.getTime() - result.startedAt.getTime(),
    };
  } catch (error) {
    outcome = {
      at: now().toISOString(),
      ok: false,
      error: (error instanceof Error ? error.message : String(error)).trim().slice(0, 480),
      backupCreatedAt: null,
      previousDatabase: null,
      durationMs: now().getTime() - started.getTime(),
    };
  }
  await mkdir(folderOf(options.dataDir), { recursive: true, mode: 0o700 });
  await writeFile(outcomePath(options.dataDir), JSON.stringify(outcome), { mode: 0o600 });
  options.log?.(outcome.ok ? 'The restore is done.' : `The restore failed: ${outcome.error ?? ''}`);
  return outcome;
}
