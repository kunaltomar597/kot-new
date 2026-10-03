import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { BackupFileError } from '../../src/backups/backup-file.js';
import { extractTar, readTar, TarFormatError } from '../../src/backups/tar.js';
import {
  archiveWalFile,
  baseBackupName,
  copyArchivedFile,
  listArchive,
  parseBaseBackupName,
  restoreWalFile,
  WAL_SUFFIX,
  walFolder,
} from '../../src/backups/wal-archive.js';
import { clusterSystemId, stageWal } from '../../src/backups/wal-stage.js';

const SEGMENT = '000000010000000000000003';
const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** A PostgreSQL data folder with a pg_control naming system 7692286420070071139. */
function dataFolder(): string {
  const folder = temp('rp-pgdata-');
  mkdirSync(join(folder, 'global'));
  mkdirSync(join(folder, 'pg_wal'));
  const control = Buffer.alloc(64);
  control.writeBigUInt64LE(7692286420070071139n, 0);
  writeFileSync(join(folder, 'global', 'pg_control'), control);
  return folder;
}

/** One tar header block (ustar), with its checksum. */
function header(
  name: string,
  size: number,
  type: string,
  extra: { prefix?: string; link?: string } = {},
) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write('0000600\0', 100);
  block.write('0000000\0', 108);
  block.write('0000000\0', 116);
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  block.write('00000000000\0', 136);
  block.write(type, 156);
  if (extra.link !== undefined) block.write(extra.link, 157, 100, 'utf8');
  block.write('ustar\0', 257);
  block.write('00', 263);
  if (extra.prefix !== undefined) block.write(extra.prefix, 345, 155, 'utf8');
  block.fill(' ', 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return block;
}

function file(name: string, content: string, extra: { prefix?: string } = {}): Buffer[] {
  const body = Buffer.from(content);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return [header(name, body.length, '0', extra), body, padding];
}

function pax(path: string): Buffer[] {
  const record = (text: string) => {
    let length = text.length + 3;
    while (`${String(length)} ${text}\n`.length !== length) length += 1;
    return `${String(length)} ${text}\n`;
  };
  const body = Buffer.from(record(`path=${path}`));
  return [header('PaxHeader', body.length, 'x'), body, Buffer.alloc(512 - body.length)];
}

const END = [Buffer.alloc(1024)];
const source = (parts: Buffer[]) => Readable.from([Buffer.concat(parts)]);

describe('[DATA-002] wal-stage, the archive_command', () => {
  it('stages each WAL file under its cluster, once', async () => {
    const data = dataFolder();
    const staging = temp('rp-staging-');
    writeFileSync(join(data, 'pg_wal', SEGMENT), randomBytes(4096));
    expect(await clusterSystemId(data)).toBe('7692286420070071139');
    const stage = () =>
      stageWal({ source: `pg_wal/${SEGMENT}`, name: SEGMENT, stagingDir: staging, dataDir: data });
    expect(await stage()).toBe('STAGED');
    const staged = join(staging, '7692286420070071139', SEGMENT);
    expect(readFileSync(staged).equals(readFileSync(join(data, 'pg_wal', SEGMENT)))).toBe(true);
    // PostgreSQL asks again after a crash: the same file is fine.
    expect(await stage()).toBe('ALREADY_STAGED');
    // A different file under the same name is refused, as PostgreSQL asks.
    writeFileSync(join(data, 'pg_wal', SEGMENT), randomBytes(4096));
    await expect(stage()).rejects.toThrow(/different content/);
    await expect(
      stageWal({ source: 'pg_wal/x', name: '../x', stagingDir: staging, dataDir: data }),
    ).rejects.toThrow(/Not a WAL file name/);
    expect(readdirSync(join(staging, '7692286420070071139'))).toEqual([SEGMENT]);
  });
});

describe('[DATA-002] the base backup tar reader', () => {
  it('extracts files and folders with ./ names, ustar prefixes and PAX names', async () => {
    const folder = temp('rp-tar-');
    const long = `${'deep/'.repeat(30)}file`;
    const entries = await extractTar(
      source([
        ...file('backup_label', 'START WAL LOCATION: 0/2000028'),
        header('./pg_wal/archive_status/', 0, '5'),
        ...file('pg_control', 'control', { prefix: 'global' }),
        ...pax(long),
        ...file('ignored-short-name', 'long one'),
        ...END,
        Buffer.alloc(2048),
      ]),
      folder,
    );
    expect(entries.map((entry) => entry.name)).toEqual([
      'backup_label',
      'pg_wal/archive_status',
      'global/pg_control',
      long,
    ]);
    expect(readFileSync(join(folder, 'global', 'pg_control'), 'utf8')).toBe('control');
    expect(readFileSync(join(folder, ...long.split('/')), 'utf8')).toBe('long one');
    expect(existsSync(join(folder, 'pg_wal', 'archive_status'))).toBe(true);
  });

  it('refuses paths that leave the folder, links, damage and a cut-short archive', async () => {
    const read = (parts: Buffer[]) => readTar(source(parts), () => undefined);
    await expect(read([...file('../evil', 'x'), ...END])).rejects.toThrow(TarFormatError);
    await expect(read([...file('/etc/evil', 'x'), ...END])).rejects.toThrow(TarFormatError);
    await expect(read([header('pg_tblspc/1', 0, '2', { link: '/etc' }), ...END])).rejects.toThrow(
      /link/,
    );
    const damaged = Buffer.concat([...file('a', 'x'), ...END]);
    damaged[10] = 65;
    await expect(readTar(source([damaged]), () => undefined)).rejects.toThrow(/damaged/);
    await expect(read(file('a', 'x'))).rejects.toThrow(/cut short/);
    await expect(read([...file('a', 'x'), ...END, Buffer.from('more')])).rejects.toThrow(
      TarFormatError,
    );
  });
});

describe('[DATA-002] [SEC-007] the WAL archive', () => {
  const key = randomBytes(32);

  it('encrypts, checks and reads back a WAL file, once', async () => {
    const work = temp('rp-wal-');
    const plain = join(work, SEGMENT);
    // A switched segment: a little log, then zeros.
    writeFileSync(plain, Buffer.concat([randomBytes(8192), Buffer.alloc(16 * 1024 * 1024 - 8192)]));
    const root = join(work, 'archive');
    const target = join(walFolder(root, '42'), `${SEGMENT}${WAL_SUFFIX}`);
    const options = { source: plain, target, key, appVersion: '1.0.0' };
    expect(await archiveWalFile(options)).toBe('ARCHIVED');
    // Compressed: the zeros take almost no room.
    expect(readFileSync(target).length).toBeLessThan(128 * 1024);
    expect(readFileSync(target).includes(readFileSync(plain).subarray(0, 64))).toBe(false);
    expect(await archiveWalFile(options)).toBe('ALREADY_ARCHIVED');
    const back = join(work, 'restored');
    await restoreWalFile({ file: target, key, target: back });
    expect(readFileSync(back).equals(readFileSync(plain))).toBe(true);

    writeFileSync(plain, randomBytes(1024));
    await expect(archiveWalFile(options)).rejects.toThrow(/different content/);
  });

  it('copies to the second location byte for byte, and refuses a changed or foreign file', async () => {
    const work = temp('rp-wal-');
    const plain = join(work, SEGMENT);
    writeFileSync(plain, randomBytes(100_000));
    const local = join(walFolder(join(work, 'local'), '42'), `${SEGMENT}${WAL_SUFFIX}`);
    const second = join(walFolder(join(work, 'second'), '42'), `${SEGMENT}${WAL_SUFFIX}`);
    await archiveWalFile({ source: plain, target: local, key, appVersion: '1.0.0' });
    expect(await copyArchivedFile({ source: local, target: second, key })).toBe('COPIED');
    expect(await copyArchivedFile({ source: local, target: second, key })).toBe('ALREADY_THERE');
    expect(readFileSync(second).equals(readFileSync(local))).toBe(true);

    const changed = readFileSync(local);
    changed[changed.length - 20] = (changed[changed.length - 20] ?? 0) ^ 1;
    writeFileSync(second, changed);
    await expect(
      restoreWalFile({ file: second, key, target: join(work, 'x') }),
    ).rejects.toBeInstanceOf(BackupFileError);
    await expect(
      restoreWalFile({ file: local, key: randomBytes(32), target: join(work, 'y') }),
    ).rejects.toMatchObject({ code: 'WRONG_KEY' });
    expect(existsSync(join(work, 'x'))).toBe(false);
  });

  it('lists what it holds per cluster, base backups oldest first', async () => {
    const root = temp('rp-archive-');
    const end = new Date('2026-10-03T04:35:12Z');
    const name = baseBackupName(end, SEGMENT);
    expect(name).toBe(`rp-base-20261003T043512Z-${SEGMENT}.rpbase`);
    expect(parseBaseBackupName(name, '42')).toEqual({
      name,
      systemId: '42',
      endAt: end,
      startSegment: SEGMENT,
    });
    mkdirSync(join(root, 'base', '42'), { recursive: true });
    writeFileSync(join(root, 'base', '42', name), '');
    writeFileSync(
      join(root, 'base', '42', baseBackupName(new Date('2026-10-02T04:35:00Z'), SEGMENT)),
      '',
    );
    mkdirSync(walFolder(root, '42'), { recursive: true });
    for (const wal of ['000000010000000000000004', SEGMENT, '00000002.history', 'junk']) {
      writeFileSync(join(walFolder(root, '42'), `${wal}${WAL_SUFFIX}`), '');
    }
    const [system] = await listArchive(root);
    expect(system?.systemId).toBe('42');
    expect(system?.wal).toEqual([SEGMENT, '000000010000000000000004', '00000002.history']);
    expect(system?.bases.map((base) => base.endAt.toISOString())).toEqual([
      '2026-10-02T04:35:00.000Z',
      '2026-10-03T04:35:12.000Z',
    ]);
    expect(await listArchive(join(root, 'nothing'))).toEqual([]);
  });
});
