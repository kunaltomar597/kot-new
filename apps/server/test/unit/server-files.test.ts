import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkServerFiles,
  hashServerFiles,
  writeIntegrityManifest,
} from '../../src/integrity/server-files.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rp-integrity-'));
  await mkdir(join(root, 'dist', 'licensing'), { recursive: true });
  await mkdir(join(root, 'node_modules', '@rp', 'licensing', 'dist'), { recursive: true });
  await writeFile(join(root, 'dist', 'licensing', 'agent.js'), 'export const a = 1;\n');
  await writeFile(join(root, 'node_modules', '@rp', 'licensing', 'dist', 'index.js'), 'x\n');
  await writeFile(join(root, 'dist', 'agent.js.map'), '{}');
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('the server’s files (LICENCE-T5)', () => {
  it('[LIC-007] lists the server and the packages it carries, not source maps', async () => {
    expect(Object.keys(await hashServerFiles(root))).toEqual([
      'dist/licensing/agent.js',
      'node_modules/@rp/licensing/dist/index.js',
    ]);
  });

  it('[LIC-007] finds the files as released intact', async () => {
    await writeIntegrityManifest(root);
    expect(await checkServerFiles(root, true)).toBe('intact');
  });

  it('[LIC-007] finds a patched, a removed and an added file', async () => {
    await writeIntegrityManifest(root);
    await writeFile(join(root, 'dist', 'licensing', 'agent.js'), 'export const a = 2;\n');
    expect(await checkServerFiles(root, true)).toBe('modified');
    await writeIntegrityManifest(root);
    await rm(join(root, 'node_modules', '@rp', 'licensing', 'dist', 'index.js'));
    expect(await checkServerFiles(root, true)).toBe('modified');
    await writeIntegrityManifest(root);
    await writeFile(join(root, 'dist', 'extra.js'), 'y\n');
    expect(await checkServerFiles(root, true)).toBe('modified');
  });

  it('[LIC-007] treats a missing or damaged list as modified on an installed server only', async () => {
    expect(await checkServerFiles(root, false)).toBe('unchecked');
    expect(await checkServerFiles(root, true)).toBe('modified');
    await writeFile(join(root, 'integrity.json'), '{"format":1,"files":{"a":1}}');
    expect(await checkServerFiles(root, true)).toBe('modified');
    expect(await checkServerFiles(root, false)).toBe('unchecked');
  });
});
