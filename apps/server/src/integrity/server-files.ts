import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FileDigests, type IntegrityManifest, judgeIntegrity } from '@rp/domain';

/** Written beside `dist/` by the installer's build, read by the running server (LIC-007). */
export const INTEGRITY_FILE = 'integrity.json';

/** The server folder: this file is `<folder>/dist/integrity/server-files.js`. */
export const SERVER_FOLDER = fileURLToPath(new URL('../../', import.meta.url));

/** What the release vouches for: the server's own code and the workspace packages it carries. */
async function codeFolders(root: string): Promise<string[]> {
  const folders = ['dist'];
  try {
    const scope = join(root, 'node_modules', '@rp');
    for (const name of (await readdir(scope)).sort()) folders.push(`node_modules/@rp/${name}/dist`);
  } catch {
    // A development checkout has no copies of the packages.
  }
  return folders;
}

async function walk(root: string, folder: string, into: Map<string, string>): Promise<void> {
  let names: string[];
  try {
    names = await readdir(join(root, folder));
  } catch {
    return;
  }
  for (const name of names.sort()) {
    const path = `${folder}/${name}`;
    const info = await stat(join(root, path));
    if (info.isDirectory()) await walk(root, path, into);
    else if (info.isFile() && !name.endsWith('.map')) {
      into.set(
        path,
        createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      );
    }
  }
}

/** The SHA-256 of every code file under `root`. */
export async function hashServerFiles(root: string): Promise<FileDigests> {
  const found = new Map<string, string>();
  for (const folder of await codeFolders(root)) await walk(root, folder, found);
  return Object.fromEntries([...found].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The build's step: lists the files as released (`dist/integrity/write-cli.js <folder>`). */
export async function writeIntegrityManifest(root: string): Promise<IntegrityManifest> {
  const manifest: IntegrityManifest = { format: 1, files: await hashServerFiles(root) };
  await writeFile(join(root, INTEGRITY_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * `modified` when the files differ from the release's list, or when an installed server (one that
 * knows its product version) has no list; `unchecked` for a development checkout.
 */
export async function checkServerFiles(
  root: string,
  installed: boolean,
): Promise<'intact' | 'modified' | 'unchecked'> {
  let manifest: IntegrityManifest;
  try {
    const parsed = JSON.parse(await readFile(join(root, INTEGRITY_FILE), 'utf8')) as unknown;
    if (!isManifest(parsed)) return installed ? 'modified' : 'unchecked';
    manifest = parsed;
  } catch {
    return installed ? 'modified' : 'unchecked';
  }
  return judgeIntegrity(manifest, await hashServerFiles(root)).ok ? 'intact' : 'modified';
}

function isManifest(value: unknown): value is IntegrityManifest {
  if (typeof value !== 'object' || value === null) return false;
  const { format, files } = value as { format?: unknown; files?: unknown };
  return (
    format === 1 &&
    typeof files === 'object' &&
    files !== null &&
    Object.values(files).every((digest) => typeof digest === 'string')
  );
}
