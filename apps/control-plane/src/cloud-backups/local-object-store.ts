import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { type ObjectStore, partCount, partSizeFor, type StartedUpload } from './object-store.js';

/** What a local store URL lets its holder do, until when. */
const Grant = z.object({
  op: z.enum(['PUT_PART', 'GET']),
  key: z.string().min(1),
  uploadId: z.string().optional(),
  part: z.int().min(1).optional(),
  exp: z.int(),
});
export type LocalGrant = z.infer<typeof Grant>;

/** A part's bytes do not match its `Content-MD5` (S3's `BadDigest`). */
export class BadDigestError extends Error {
  constructor() {
    super('The part does not match its Content-MD5');
    this.name = 'BadDigestError';
  }
}

/** The path the Control Plane serves the local store's signed URLs at. */
export const LOCAL_STORE_PATH = '/v1/object-store';

/**
 * Object storage in a folder (development and tests, P7-05d): the same signed-URL flow as S3,
 * served by the Control Plane itself at `/v1/object-store/<grant>`. Never used in staging or
 * production, where backups go to S3 in India.
 */
export class LocalObjectStore implements ObjectStore {
  private readonly secret: Buffer;
  private readonly now: () => Date;

  constructor(
    private readonly folder: string,
    private readonly options: {
      readonly secret?: Buffer;
      readonly now?: () => Date;
      /** Smaller parts than S3 allows, so tests can upload several (tests only). */
      readonly partBytes?: number;
    } = {},
  ) {
    this.secret = options.secret ?? randomBytes(32);
    this.now = options.now ?? (() => new Date());
  }

  private path(...parts: string[]): string {
    const root = resolve(this.folder);
    const path = resolve(root, ...parts);
    if (!path.startsWith(root + sep)) throw new Error('A key leaves the store');
    return path;
  }

  private objectPath(key: string): string {
    return this.path('objects', ...key.split('/'));
  }

  private uploadPath(uploadId: string, part?: number): string {
    if (!/^[0-9a-f-]{36}$/.test(uploadId)) throw new Error('Not an upload id');
    return part === undefined
      ? this.path('uploads', uploadId)
      : this.path('uploads', uploadId, String(part).padStart(5, '0'));
  }

  /** A signed grant, for a URL. */
  grant(grant: Omit<LocalGrant, 'exp'>, expiresSeconds: number): string {
    const body = Buffer.from(
      JSON.stringify({ ...grant, exp: Math.floor(this.now().getTime() / 1000) + expiresSeconds }),
    ).toString('base64url');
    const mac = createHmac('sha256', this.secret).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  /** The grant a URL carries, if its signature holds and it has not expired. */
  verify(token: string): LocalGrant | null {
    const [body, mac] = token.split('.');
    if (body === undefined || mac === undefined) return null;
    const expected = createHmac('sha256', this.secret).update(body).digest();
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const parsed = Grant.safeParse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
      if (!parsed.success) return null;
      return parsed.data.exp * 1000 < this.now().getTime() ? null : parsed.data;
    } catch {
      return null;
    }
  }

  async startUpload(
    key: string,
    sizeBytes: number,
    expiresSeconds: number,
  ): Promise<StartedUpload> {
    const uploadId = randomUUID();
    await mkdir(this.uploadPath(uploadId), { recursive: true });
    const partSize = this.options.partBytes ?? partSizeFor(sizeBytes);
    const parts = Array.from({ length: partCount(sizeBytes, partSize) }, (_, index) => ({
      number: index + 1,
      url: `${LOCAL_STORE_PATH}/${this.grant({ op: 'PUT_PART', key, uploadId, part: index + 1 }, expiresSeconds)}`,
    }));
    return { uploadId, partSize, parts };
  }

  /**
   * Stores one part, as the PUT to its URL does; returns its ETag (MD5, like S3). A part whose
   * bytes do not match the `Content-MD5` sent with them is refused, as S3 does.
   */
  async putPart(grant: LocalGrant, body: Readable, contentMd5?: string): Promise<string> {
    if (grant.op !== 'PUT_PART' || grant.uploadId === undefined || grant.part === undefined) {
      throw new Error('Not a part upload');
    }
    const target = this.uploadPath(grant.uploadId, grant.part);
    const hash = createHash('md5');
    await mkdir(dirname(target), { recursive: true });
    await pipeline(
      body,
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(`${target}.partial`),
    );
    const digest = hash.digest();
    if (contentMd5 !== undefined && digest.toString('base64') !== contentMd5) {
      await rm(`${target}.partial`, { force: true });
      throw new BadDigestError();
    }
    await rename(`${target}.partial`, target);
    return `"${digest.toString('hex')}"`;
  }

  async completeUpload(
    key: string,
    uploadId: string,
    parts: readonly { readonly number: number; readonly etag: string }[],
  ): Promise<void> {
    const target = this.objectPath(key);
    await mkdir(dirname(target), { recursive: true });
    const out = createWriteStream(`${target}.partial`);
    try {
      for (const part of [...parts].sort((a, b) => a.number - b.number)) {
        const file = this.uploadPath(uploadId, part.number);
        const hash = createHash('md5');
        for await (const chunk of createReadStream(file)) {
          hash.update(chunk as Buffer);
          if (!out.write(chunk)) {
            await new Promise<void>((ready) => {
              out.once('drain', () => {
                ready();
              });
            });
          }
        }
        if (`"${hash.digest('hex')}"` !== part.etag) {
          throw new Error(`Part ${String(part.number)} does not match its ETag`);
        }
      }
      await new Promise<void>((done) => {
        out.end(() => {
          done();
        });
      });
      await rename(`${target}.partial`, target);
    } catch (error) {
      out.destroy();
      await rm(`${target}.partial`, { force: true });
      throw error;
    }
    await rm(this.uploadPath(uploadId), { recursive: true, force: true });
  }

  async abortUpload(_key: string, uploadId: string): Promise<void> {
    await rm(this.uploadPath(uploadId), { recursive: true, force: true });
  }

  async sizeOf(key: string): Promise<number | null> {
    return stat(this.objectPath(key)).then(
      (stats) => stats.size,
      () => null,
    );
  }

  async remove(key: string): Promise<void> {
    await rm(this.objectPath(key), { force: true });
  }

  downloadUrl(key: string, expiresSeconds: number): Promise<string> {
    return Promise.resolve(`${LOCAL_STORE_PATH}/${this.grant({ op: 'GET', key }, expiresSeconds)}`);
  }

  /** The object's bytes, for the GET to a download URL. */
  open(grant: LocalGrant): Readable {
    if (grant.op !== 'GET') throw new Error('Not a download');
    return createReadStream(this.objectPath(grant.key));
  }

  /** Every object key (tests). */
  async keys(): Promise<string[]> {
    const root = join(resolve(this.folder), 'objects');
    const out: string[] = [];
    const walk = async (folder: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) await walk(join(folder, entry.name), `${prefix}${entry.name}/`);
        else if (!entry.name.endsWith('.partial')) out.push(`${prefix}${entry.name}`);
      }
    };
    await walk(root, '');
    return out.sort();
  }
}
