import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesBelow, missingFromBuild } from '../src/packaging/copied.js';

function tree(root: string, files: readonly string[]): void {
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), file);
  }
}

describe('[ONB-001] [UPD-007] everything staged reaches the installer (P0-16d)', () => {
  it('names the staged files the built app lacks, a whole node_modules among them', async () => {
    const base = mkdtempSync(join(tmpdir(), 'rp-copied-'));
    const payload = join(base, 'payload');
    const built = join(base, 'built');
    tree(payload, [
      'server/dist/main.js',
      'server/node_modules/zod/package.json',
      'server/node_modules/zod/index.js',
      'node/node.exe',
    ]);
    // What electron-builder made of per-folder sets: the server without its node_modules.
    tree(built, ['server/dist/main.js', 'node/node.exe']);
    expect(await filesBelow(join(payload, 'server'))).toEqual([
      'dist/main.js',
      'node_modules/zod/index.js',
      'node_modules/zod/package.json',
    ]);
    expect(await missingFromBuild(payload, built, ['server', 'node'])).toEqual([
      'server/node_modules/zod/index.js',
      'server/node_modules/zod/package.json',
    ]);
    // A folder that never arrived is missing whole.
    expect(await missingFromBuild(payload, join(base, 'nothing'), ['node'])).toEqual([
      'node/node.exe',
    ]);
    tree(built, ['server/node_modules/zod/package.json', 'server/node_modules/zod/index.js']);
    expect(await missingFromBuild(payload, built, ['server', 'node'])).toEqual([]);
  });
});
