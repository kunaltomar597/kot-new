import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { open } from 'node:fs/promises';
import { Transform, type TransformCallback } from 'node:stream';
import { z } from 'zod';

/**
 * The encrypted backup file (DATA-002, DATA-003, SEC-007, P7-05a): AES-256-GCM in authenticated
 * chunks, so a file that was changed, cut short, reordered or made with another key is refused.
 *
 *   "RPBK" | version (1 byte) | header length (u32) | header (JSON)
 *   then chunks: ciphertext length (u32) | ciphertext | GCM tag (16 bytes)
 *
 * Each file has its own key, derived from the backup key with a random salt (HKDF-SHA256), so
 * the chunk counter is a safe nonce. Every chunk authenticates the header, its index and whether
 * it is the last one.
 */

const MAGIC = Buffer.from('RPBK', 'ascii');
const VERSION = 1;
const TAG_BYTES = 16;
/** Plaintext per chunk. */
export const BACKUP_CHUNK_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

export const BackupHeader = z.object({
  /** What the file holds: a full backup (P7-05a), archived WAL (P7-05c). */
  kind: z.enum(['FULL', 'WAL']),
  createdAt: z.iso.datetime(),
  /** Which backup key opens it (`backupKeyId`). */
  keyId: z.string().regex(/^[0-9a-f]{16}$/),
  salt: z.base64(),
  chunkBytes: z.int().min(1).max(MAX_CHUNK_BYTES),
  /** The server version that made it. */
  appVersion: z.string().max(64),
});
export type BackupHeader = z.infer<typeof BackupHeader>;

/** Why a file could not be read; `code` is stable for callers and tests. */
export class BackupFileError extends Error {
  constructor(
    readonly code: 'NOT_A_BACKUP' | 'WRONG_KEY' | 'DAMAGED' | 'TRUNCATED',
    message: string,
  ) {
    super(message);
    this.name = 'BackupFileError';
  }
}

/** A short, non-secret name for a backup key: which key a file needs, without revealing it. */
export function backupKeyId(key: Buffer): string {
  return createHmac('sha256', key).update('rp-backup-key-id').digest('hex').slice(0, 16);
}

function fileKey(key: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', key, salt, 'rp-backup-v1', 32));
}

function prefixOf(header: BackupHeader): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), length, json]);
}

function nonceOf(index: number): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(index), 4);
  return nonce;
}

function aadOf(prefixDigest: Buffer, index: number, final: boolean): Buffer {
  const aad = Buffer.alloc(prefixDigest.length + 9);
  prefixDigest.copy(aad);
  aad.writeBigUInt64BE(BigInt(index), prefixDigest.length);
  aad.writeUInt8(final ? 1 : 0, prefixDigest.length + 8);
  return aad;
}

/** Bytes as they arrive, taken from the front without copying everything on every arrival. */
export class ByteQueue {
  private parts: Buffer[] = [];
  size = 0;

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.parts.push(chunk);
    this.size += chunk.length;
  }

  /** The first `count` bytes, left in the queue. */
  peek(count: number): Buffer {
    this.gather(count);
    return (this.parts[0] ?? Buffer.alloc(0)).subarray(0, count);
  }

  /** Removes and returns the first `count` bytes (at most `size`). */
  take(count: number): Buffer {
    const wanted = Math.min(count, this.size);
    this.gather(wanted);
    const first = this.parts[0] ?? Buffer.alloc(0);
    const taken = first.subarray(0, wanted);
    if (first.length === wanted) this.parts.shift();
    else this.parts[0] = first.subarray(wanted);
    this.size -= wanted;
    return taken;
  }

  /** Joins parts until the first holds at least `count` bytes. */
  private gather(count: number): void {
    const first = this.parts[0];
    if (first === undefined || first.length >= count) return;
    let joined = 0;
    let parts = 0;
    for (const part of this.parts) {
      if (joined >= count) break;
      joined += part.length;
      parts += 1;
    }
    this.parts.splice(0, parts, Buffer.concat(this.parts.slice(0, parts)));
  }
}

/** Encrypts a stream into a backup file. */
export function encryptBackup(
  key: Buffer,
  options: {
    readonly kind: BackupHeader['kind'];
    readonly appVersion: string;
    readonly now?: Date;
  },
): Transform {
  const salt = randomBytes(32);
  const header: BackupHeader = {
    kind: options.kind,
    createdAt: (options.now ?? new Date()).toISOString(),
    keyId: backupKeyId(key),
    salt: salt.toString('base64'),
    chunkBytes: BACKUP_CHUNK_BYTES,
    appVersion: options.appVersion,
  };
  const prefix = prefixOf(header);
  const digest = createHash('sha256').update(prefix).digest();
  const derived = fileKey(key, salt);
  let index = 0;
  const pending = new ByteQueue();
  let started = false;

  const seal = (plain: Buffer, final: boolean): Buffer => {
    const cipher = createCipheriv('aes-256-gcm', derived, nonceOf(index));
    cipher.setAAD(aadOf(digest, index, final));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    index += 1;
    return Buffer.concat([length, body, cipher.getAuthTag()]);
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      if (!started) {
        this.push(prefix);
        started = true;
      }
      pending.push(chunk);
      // The last chunk is marked as such, so one full chunk is always held back for the end.
      while (pending.size > BACKUP_CHUNK_BYTES) {
        this.push(seal(pending.take(BACKUP_CHUNK_BYTES), false));
      }
      callback();
    },
    flush(callback: TransformCallback) {
      if (!started) this.push(prefix);
      this.push(seal(pending.take(pending.size), true));
      callback();
    },
  });
}

function parsePrefix(buffer: Buffer): { header: BackupHeader; length: number } | 'MORE' {
  if (buffer.length < 9) {
    if (!MAGIC.subarray(0, buffer.length).equals(buffer.subarray(0, MAGIC.length))) {
      throw new BackupFileError('NOT_A_BACKUP', 'This file is not a backup made by this system.');
    }
    return 'MORE';
  }
  if (!buffer.subarray(0, 4).equals(MAGIC) || buffer.readUInt8(4) !== VERSION) {
    throw new BackupFileError('NOT_A_BACKUP', 'This file is not a backup made by this system.');
  }
  const headerLength = buffer.readUInt32BE(5);
  if (headerLength > MAX_HEADER_BYTES) {
    throw new BackupFileError('NOT_A_BACKUP', 'This file is not a backup made by this system.');
  }
  if (buffer.length < 9 + headerLength) return 'MORE';
  let json: unknown;
  try {
    json = JSON.parse(buffer.subarray(9, 9 + headerLength).toString('utf8'));
  } catch {
    throw new BackupFileError('NOT_A_BACKUP', 'This file is not a backup made by this system.');
  }
  const parsed = BackupHeader.safeParse(json);
  if (!parsed.success) {
    throw new BackupFileError('NOT_A_BACKUP', 'This file is not a backup made by this system.');
  }
  return { header: parsed.data, length: 9 + headerLength };
}

/** Reads a backup file's header without the key: what it is, when it was made, which key. */
export async function readBackupHeader(path: string): Promise<BackupHeader> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(9 + MAX_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const parsed = parsePrefix(buffer.subarray(0, bytesRead));
    if (parsed === 'MORE') {
      throw new BackupFileError('TRUNCATED', 'The backup file is cut short.');
    }
    return parsed.header;
  } finally {
    await handle.close();
  }
}

/**
 * Decrypts a backup file, checking every chunk. Fails with `BackupFileError` when the file is
 * not a backup, needs another key, was changed or is cut short. `onHeader` sees the header first.
 */
export function decryptBackup(
  key: Buffer,
  options: { readonly onHeader?: (header: BackupHeader) => void } = {},
): Transform {
  const buffer = new ByteQueue();
  let header: BackupHeader | undefined;
  let digest: Buffer | undefined;
  let derived: Buffer | undefined;
  let index = 0;
  let finished = false;

  const step = (push: (chunk: Buffer) => void): void => {
    if (header === undefined) {
      const parsed = parsePrefix(buffer.peek(Math.min(buffer.size, 9 + MAX_HEADER_BYTES)));
      if (parsed === 'MORE') return;
      if (parsed.header.keyId !== backupKeyId(key)) {
        throw new BackupFileError(
          'WRONG_KEY',
          'This backup was made with another backup key (another PC or installation).',
        );
      }
      header = parsed.header;
      digest = createHash('sha256').update(buffer.take(parsed.length)).digest();
      derived = fileKey(key, Buffer.from(header.salt, 'base64'));
      options.onHeader?.(header);
    }
    while (buffer.size >= 4) {
      if (finished) {
        throw new BackupFileError('DAMAGED', 'The backup file has data after its end.');
      }
      const length = buffer.peek(4).readUInt32BE(0);
      if (derived === undefined || digest === undefined) return;
      if (length > header.chunkBytes) {
        throw new BackupFileError('DAMAGED', 'The backup file is damaged or was changed.');
      }
      if (buffer.size < 4 + length + TAG_BYTES) return;
      const record = buffer.take(4 + length + TAG_BYTES);
      const body = record.subarray(4, 4 + length);
      const tag = record.subarray(4 + length);
      // A short chunk can only be the last one; a full one may be either.
      const candidates = length < header.chunkBytes ? [true] : [false, true];
      let plain: Buffer | undefined;
      for (const final of candidates) {
        try {
          const decipher = createDecipheriv('aes-256-gcm', derived, nonceOf(index));
          decipher.setAAD(aadOf(digest, index, final));
          decipher.setAuthTag(tag);
          plain = Buffer.concat([decipher.update(body), decipher.final()]);
          finished = final;
          break;
        } catch {
          // Tried as the other kind of chunk next, or refused below.
        }
      }
      if (plain === undefined) {
        throw new BackupFileError('DAMAGED', 'The backup file is damaged or was changed.');
      }
      index += 1;
      if (plain.length > 0) push(plain);
    }
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      buffer.push(chunk);
      try {
        step((plain) => this.push(plain));
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback: TransformCallback) {
      if (header === undefined || !finished || buffer.size > 0) {
        callback(
          header === undefined && buffer.size > 0 && buffer.size < 9
            ? new BackupFileError('NOT_A_BACKUP', 'This file is not a backup made by this system.')
            : new BackupFileError('TRUNCATED', 'The backup file is cut short.'),
        );
        return;
      }
      callback();
    },
  });
}
