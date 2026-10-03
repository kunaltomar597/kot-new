import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import {
  ArchiveFormatError,
  isSafeEntryName,
  readArchive,
  writeArchive,
} from '../../src/backups/backup-archive.js';
import {
  BACKUP_CHUNK_BYTES,
  BackupFileError,
  ByteQueue,
  backupKeyId,
  decryptBackup,
  encryptBackup,
  readBackupHeader,
} from '../../src/backups/backup-file.js';

const key = randomBytes(32);

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(part);
  return Buffer.concat(parts);
}

async function encrypt(plain: Buffer, withKey = key): Promise<Buffer> {
  const out: Buffer[] = [];
  await pipeline(
    Readable.from([plain.subarray(0, 1000), plain.subarray(1000)]),
    encryptBackup(withKey, { kind: 'FULL', appVersion: '0.1.0' }),
    async (source: AsyncIterable<Buffer>) => {
      for await (const part of source) out.push(part);
    },
  );
  return Buffer.concat(out);
}

async function decrypt(file: Buffer, withKey = key): Promise<Buffer> {
  // Fed in uneven pieces, as a disk read would.
  const pieces: Buffer[] = [];
  for (let offset = 0; offset < file.length; offset += 70_001) {
    pieces.push(file.subarray(offset, offset + 70_001));
  }
  const out: Buffer[] = [];
  await pipeline(Readable.from(pieces), decryptBackup(withKey), async (source) => {
    for await (const part of source as AsyncIterable<Buffer>) out.push(part);
  });
  return Buffer.concat(out);
}

describe('[DATA-002] [SEC-007] the encrypted backup file', () => {
  it('round-trips data of any size, in authenticated chunks', async () => {
    for (const size of [0, 1, BACKUP_CHUNK_BYTES, BACKUP_CHUNK_BYTES + 1, 3 * BACKUP_CHUNK_BYTES]) {
      const plain = randomBytes(size);
      const file = await encrypt(plain);
      expect((await decrypt(file)).equals(plain), `size ${String(size)}`).toBe(true);
      // Nothing of the content shows through.
      if (size >= 64) expect(file.includes(plain.subarray(0, 32))).toBe(false);
    }
  });

  it('[DATA-002] detects a changed byte, a cut, a swapped chunk and extra data', async () => {
    const plain = randomBytes(2 * BACKUP_CHUNK_BYTES + 500);
    const file = await encrypt(plain);
    const fail = (bytes: Buffer) =>
      decrypt(bytes).then(
        () => 'opened',
        (error: unknown) => (error instanceof BackupFileError ? error.code : String(error)),
      );

    const flipped = Buffer.from(file);
    flipped[file.length - 100] = flipped[file.length - 100]! ^ 1;
    expect(await fail(flipped)).toBe('DAMAGED');

    // Cut after the first chunk: every chunk checks out, but the last one is missing.
    const headerLength = 9 + file.readUInt32BE(5);
    const firstChunk = 4 + BACKUP_CHUNK_BYTES + 16;
    expect(await fail(file.subarray(0, headerLength + firstChunk))).toBe('TRUNCATED');
    expect(await fail(file.subarray(0, file.length - 10))).toBe('TRUNCATED');

    // The first two chunks swapped.
    const chunks = file.subarray(headerLength);
    const swapped = Buffer.concat([
      file.subarray(0, headerLength),
      chunks.subarray(firstChunk, 2 * firstChunk),
      chunks.subarray(0, firstChunk),
      chunks.subarray(2 * firstChunk),
    ]);
    expect(await fail(swapped)).toBe('DAMAGED');

    expect(await fail(Buffer.concat([file, Buffer.from([0, 0, 0, 0])]))).toBe('DAMAGED');

    // The header is authenticated too: a changed creation time breaks every chunk.
    const edited = Buffer.from(
      file.toString('latin1').replace('"createdAt":"20', '"createdAt":"19'),
      'latin1',
    );
    expect(await fail(edited)).toBe('DAMAGED');
  });

  it('refuses another key and a file that is not a backup', async () => {
    const file = await encrypt(randomBytes(100));
    const other = randomBytes(32);
    await expect(decrypt(file, other)).rejects.toMatchObject({ code: 'WRONG_KEY' });
    await expect(decrypt(Buffer.from('PK\u0003\u0004 a zip file'))).rejects.toMatchObject({
      code: 'NOT_A_BACKUP',
    });
  });

  it('shows which key a file needs without the key', async () => {
    const file = await encrypt(randomBytes(10));
    const path = join(mkdtempSync(join(tmpdir(), 'rp-backup-')), 'test.rpbk');
    writeFileSync(path, file);
    const header = await readBackupHeader(path);
    expect(header).toMatchObject({ kind: 'FULL', keyId: backupKeyId(key), appVersion: '0.1.0' });
    expect(backupKeyId(key)).not.toBe(backupKeyId(randomBytes(32)));
  });
});

describe('[DATA-002] the files inside a backup', () => {
  it('writes and reads named entries of any length', async () => {
    const big = randomBytes(600_000);
    const bytes = await collect(
      writeArchive([
        { name: 'backup.json', content: ['{"a":1}'] },
        { name: 'database.dump', content: [big.subarray(0, 10), big.subarray(10)] },
        { name: 'files/photos/empty.webp', content: [] },
      ]),
    );
    const read: Record<string, Buffer> = {};
    const names = await readArchive(Readable.from([bytes]), (name) => {
      const parts: Buffer[] = [];
      return {
        write: (part) => {
          parts.push(part);
        },
        end: () => {
          read[name] = Buffer.concat(parts);
        },
      };
    });
    expect(names).toEqual(['backup.json', 'database.dump', 'files/photos/empty.webp']);
    expect(read['backup.json']?.toString()).toBe('{"a":1}');
    expect(read['database.dump']?.equals(big)).toBe(true);
    expect(read['files/photos/empty.webp']).toHaveLength(0);
  });

  it('refuses unsafe names and a cut archive', async () => {
    expect(isSafeEntryName('files/../secrets')).toBe(false);
    expect(isSafeEntryName('/etc/passwd')).toBe(false);
    expect(isSafeEntryName('files\\x')).toBe(false);
    expect(isSafeEntryName('files/photos/a.webp')).toBe(true);
    const bytes = await collect(writeArchive([{ name: 'a', content: ['hello'] }]));
    const sink = () => ({ write: () => undefined, end: () => undefined });
    await expect(readArchive(Readable.from([bytes.subarray(0, 12)]), sink)).rejects.toBeInstanceOf(
      ArchiveFormatError,
    );
    await expect(
      readArchive(Readable.from([Buffer.concat([bytes, Buffer.from('x')])]), sink),
    ).rejects.toBeInstanceOf(ArchiveFormatError);
  });

  it('queues bytes without losing any', () => {
    const queue = new ByteQueue();
    queue.push(Buffer.from('ab'));
    queue.push(Buffer.from('cde'));
    queue.push(Buffer.from('f'));
    expect(queue.peek(3).toString()).toBe('abc');
    expect(queue.take(4).toString()).toBe('abcd');
    expect(queue.take(10).toString()).toBe('ef');
    expect(queue.size).toBe(0);
  });
});
