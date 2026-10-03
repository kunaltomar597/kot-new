import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * PostgreSQL's `archive_command` (DATA-002, P7-05c): hands each finished WAL file to the server
 * by copying it into the staging folder on the data drive, under the cluster's system id. The
 * server encrypts it into the archive and copies it to the second location; this step needs no
 * key, no database and no second drive, so an unplugged USB drive never stops PostgreSQL.
 *
 *   archive_command = '"<node>" "<server>/dist/backups/wal-stage.js" "%p" "%f" "<data>/backups/wal-staging"'
 *
 * PostgreSQL runs it in its data folder, where `global/pg_control` names the cluster. Only Node's
 * own modules are used, so it starts quickly for every 16 MB of log.
 */

/** A file PostgreSQL archives: a segment, a partial segment, a backup or timeline history. */
const WAL_FILE_NAME = /^(?:[0-9A-F]{24}(?:\.partial|\.[0-9A-F]{8}\.backup)?|[0-9A-F]{8}\.history)$/;

/** The cluster's system identifier: the first field of `global/pg_control` (little-endian). */
export async function clusterSystemId(dataDir: string): Promise<string> {
  const handle = await open(join(dataDir, 'global', 'pg_control'), 'r');
  try {
    const buffer = Buffer.alloc(8);
    const { bytesRead } = await handle.read(buffer, 0, 8, 0);
    if (bytesRead !== 8) throw new Error('global/pg_control is too short');
    return buffer.readBigUInt64LE(0).toString();
  } finally {
    await handle.close();
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Flushes a folder's entries (a rename) to disk; Windows cannot open folders, and needs not. */
async function syncFolder(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Stages one WAL file. Staging the same file again succeeds (PostgreSQL retries after a crash);
 * a different file under a name already staged is refused, as PostgreSQL's documentation asks.
 */
export async function stageWal(options: {
  /** `%p`: the file, relative to the data folder. */
  readonly source: string;
  /** `%f`: its name. */
  readonly name: string;
  readonly stagingDir: string;
  /** PostgreSQL's data folder (the working folder when PostgreSQL runs the command). */
  readonly dataDir: string;
}): Promise<'STAGED' | 'ALREADY_STAGED'> {
  if (!WAL_FILE_NAME.test(options.name)) throw new Error(`Not a WAL file name: ${options.name}`);
  const folder = join(options.stagingDir, await clusterSystemId(options.dataDir));
  const source = resolve(options.dataDir, options.source);
  const target = join(folder, options.name);
  const existing = await readFile(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (existing !== null) {
    if (existing.equals(await readFile(source))) return 'ALREADY_STAGED';
    throw new Error(`${options.name} is staged already with different content`);
  }
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const partial = `${target}.tmp-${String(process.pid)}`;
  try {
    await copyFile(source, partial);
    await syncFile(partial);
    await rename(partial, target);
    await syncFolder(folder);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return 'STAGED';
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, name, stagingDir] = process.argv.slice(2);
  if (source === undefined || name === undefined || stagingDir === undefined) {
    process.stderr.write('Usage: wal-stage <%p> <%f> <staging folder>\n');
    process.exitCode = 2;
  } else {
    stageWal({ source, name, stagingDir, dataDir: process.cwd() }).then(
      () => undefined,
      (error: unknown) => {
        process.stderr.write(
          `wal-stage: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      },
    );
  }
}
