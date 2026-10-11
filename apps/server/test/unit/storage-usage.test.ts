import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { directoryBytes, storageLevel, usedPercent } from '../../src/system/storage-usage.js';

describe('[DATA-006] storage on the data drive', () => {
  it('warns at the warning level and is critical at the critical one', () => {
    expect(storageLevel(79, 80, 90)).toBe('OK');
    expect(storageLevel(80, 80, 90)).toBe('WARNING');
    expect(storageLevel(90, 80, 90)).toBe('CRITICAL');
    expect(storageLevel(null, 80, 90)).toBe('UNKNOWN');
  });

  it('rounds the use of the drive to whole percent', () => {
    expect(usedPercent({ totalBytes: 1_000, freeBytes: 155 })).toBe(85);
    expect(usedPercent({ totalBytes: 0, freeBytes: 0 })).toBe(0);
  });

  it('adds up the files in a folder and its sub-folders, or says it is not there', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rp-bytes-'));
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'one.bin'), Buffer.alloc(10));
    writeFileSync(join(root, 'a', 'b', 'two.bin'), Buffer.alloc(32));
    expect(await directoryBytes(root)).toBe(42);
    expect(await directoryBytes(join(root, 'missing'))).toBeNull();
  });
});
