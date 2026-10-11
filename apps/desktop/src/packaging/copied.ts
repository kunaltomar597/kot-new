import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * Every file under `root`, as paths with "/" relative to it (folders left out, so empty folders do
 * not count).
 */
export async function filesBelow(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(root, path).split(sep).join('/'));
    }
  };
  await walk(root);
  return found.sort();
}

/**
 * The staged files of these folders that did not reach the built app (P0-16d). electron-builder
 * leaves some out without a word (a node_modules at the root of a copied set), and an installed
 * server without them cannot start; the build stops on any.
 */
export async function missingFromBuild(
  payload: string,
  built: string,
  folders: readonly string[],
): Promise<string[]> {
  const missing: string[] = [];
  for (const folder of folders) {
    const staged = await filesBelow(join(payload, folder));
    const there = new Set(await filesBelow(join(built, folder)).catch(() => [] as string[]));
    for (const file of staged) if (!there.has(file)) missing.push(`${folder}/${file}`);
  }
  return missing;
}
