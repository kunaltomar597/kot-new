import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileLog } from '../src/file-log.js';

describe('[SEC-011] [DESKTOP-R2] the shell’s log file', () => {
  const now = () => new Date('2026-10-10T05:00:00Z');

  it('appends one dated line per event, creating the folder', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rp-shell-')), 'logs', 'desktop-shell.log');
    const log = fileLog(file, { now });
    log('Refused the permission geolocation');
    log('two\nlines');
    expect(readFileSync(file, 'utf8')).toBe(
      '2026-10-10T05:00:00.000Z Refused the permission geolocation\n2026-10-10T05:00:00.000Z two lines\n',
    );
  });

  it('starts a new file past 1 MB, keeping the old one beside it', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rp-shell-')), 'desktop-shell.log');
    writeFileSync(file, 'x'.repeat(1024 * 1024 + 1));
    fileLog(file, { now })('fresh');
    expect(readFileSync(file, 'utf8')).toBe('2026-10-10T05:00:00.000Z fresh\n');
    expect(readFileSync(`${file}.1`, 'utf8')).toHaveLength(1024 * 1024 + 1);
  });

  it('never throws, and writes nowhere without a file', () => {
    expect(() => {
      fileLog('x', {
        write: () => {
          throw new Error('disk full');
        },
      })('event');
    }).not.toThrow();
    const writes: string[] = [];
    fileLog(undefined, { write: (_f, text) => writes.push(text) })('event');
    expect(writes).toEqual([]);
  });
});
