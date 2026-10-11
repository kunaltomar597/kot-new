import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

/**
 * Trims the server's deployed `node_modules` (P0-16d) to what it can load. `pnpm deploy` follows
 * the workspace lockfile, whose `auto-install-peers` brings optional peers such as the Prisma CLI
 * and TypeScript along; nothing at run time asks for them. Starting from the server's package,
 * every package reachable through `dependencies`, `optionalDependencies` and required peers is
 * kept, found the way Node.js resolves them (the nearest `node_modules` up the tree); the rest is
 * deleted. The layout must be hoisted (`node-linker=hoisted`): real folders, no links.
 */

interface PackageJson {
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

async function readPackage(dir: string): Promise<PackageJson> {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as PackageJson;
}

async function isPackage(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, 'package.json'))).isFile();
  } catch {
    return false;
  }
}

/** The names a package needs at run time. */
export function runtimeDependencies(pkg: PackageJson): string[] {
  const optionalPeers = pkg.peerDependenciesMeta ?? {};
  const peers = Object.keys(pkg.peerDependencies ?? {}).filter(
    (name) => optionalPeers[name]?.optional !== true,
  );
  return [
    ...new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...peers,
    ]),
  ];
}

/** Where Node.js finds `name` from a package in `dir`, without leaving `root`; undefined if absent. */
async function resolvePackage(
  root: string,
  dir: string,
  name: string,
): Promise<string | undefined> {
  for (let current = dir; ; current = dirname(current)) {
    const candidate = join(current, 'node_modules', name);
    if (await isPackage(candidate)) return candidate;
    if (current === root || !current.startsWith(root)) return undefined;
  }
}

/** Every package folder under `root/node_modules`, nested ones included. */
export async function installedPackages(nodeModules: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(nodeModules);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const dirs = entry.startsWith('@')
      ? (await readdir(join(nodeModules, entry))).map((name) => join(nodeModules, entry, name))
      : [join(nodeModules, entry)];
    for (const dir of dirs) {
      if (!(await isPackage(dir))) continue;
      found.push(dir, ...(await installedPackages(join(dir, 'node_modules'))));
    }
  }
  return found;
}

/** The package folders the package at `root` can load. */
export async function reachablePackages(root: string): Promise<Set<string>> {
  const reachable = new Set<string>();
  const queue = [root];
  for (let dir = queue.pop(); dir !== undefined; dir = queue.pop()) {
    for (const name of runtimeDependencies(await readPackage(dir))) {
      const found = await resolvePackage(root, dir, name);
      if (found !== undefined && !reachable.has(found)) {
        reachable.add(found);
        queue.push(found);
      }
    }
  }
  return reachable;
}

/** Deletes the packages nothing reaches, and pnpm's bookkeeping; returns what was deleted. */
export async function pruneUnreachable(root: string): Promise<string[]> {
  const reachable = await reachablePackages(root);
  const nodeModules = join(root, 'node_modules');
  const removed: string[] = [];
  for (const dir of await installedPackages(nodeModules)) {
    // A package inside one that is already gone went with it.
    if (reachable.has(dir) || removed.some((gone) => dir.startsWith(gone + sep))) continue;
    await rm(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  for (const bookkeeping of ['.bin', '.pnpm', '.modules.yaml', '.pnpm-workspace-state-v1.json']) {
    await rm(join(nodeModules, bookkeeping), { recursive: true, force: true });
  }
  return removed.map((dir) => relative(root, dir));
}
