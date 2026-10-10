import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { EMPTY_SHA256, presignUrl, signHeaders } from '../../src/cloud-backups/aws-sigv4.js';
import { BadDigestError, LocalObjectStore } from '../../src/cloud-backups/local-object-store.js';
import { MAX_PARTS, partCount, partSizeFor } from '../../src/cloud-backups/object-store.js';
import { S3Error, S3ObjectStore } from '../../src/cloud-backups/s3-object-store.js';
import { loadConfig } from '../../src/config/cp-config.js';

/** AWS's own example credentials and time (S3 documentation, "Signature Version 4"). */
const EXAMPLE = {
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
  now: new Date('2013-05-24T00:00:00Z'),
  region: 'us-east-1',
  service: 's3',
};
const MiB = 1024 * 1024;

describe('[DATA-003] signing requests to S3 (Signature Version 4)', () => {
  it('matches AWS’s example of a signed GET', () => {
    const headers = signHeaders({
      ...EXAMPLE,
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9' },
      payloadHash: EMPTY_SHA256,
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('matches AWS’s example of a presigned URL', () => {
    const url = presignUrl({
      ...EXAMPLE,
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      expiresSeconds: 86_400,
    });
    expect(url).toMatch(
      /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/,
    );
  });
});

describe('[DATA-003] parts of a large backup', () => {
  it('uses 64 MiB parts, larger when a file would need more than 10,000', () => {
    expect(partSizeFor(10 * MiB)).toBe(64 * MiB);
    expect(partCount(10 * MiB, 64 * MiB)).toBe(1);
    const huge = 1024 * 1024 * MiB; // 1 TiB
    expect(partCount(huge, partSizeFor(huge))).toBeLessThanOrEqual(MAX_PARTS);
  });
});

/** A fake S3 that records requests and answers as S3 does. */
function fakeS3(answers: (method: string, url: URL) => Response) {
  const calls: { method: string; url: URL; headers: Headers; body: string }[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return Promise.resolve(answers(method, url));
  };
  return { fetch, calls };
}

describe('[DATA-003] the S3 store', () => {
  const options = {
    endpoint: 'https://s3.ap-south-1.amazonaws.com',
    region: 'ap-south-1',
    bucket: 'rp-backups',
    credentials: EXAMPLE.credentials,
    now: () => new Date('2026-10-03T00:00:00Z'),
  };

  it('starts a multipart upload with a presigned URL per part, then joins the parts in order', async () => {
    const s3 = fakeS3((method, url) =>
      method === 'POST' && url.searchParams.has('uploads')
        ? new Response(
            '<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>',
          )
        : new Response('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>'),
    );
    const store = new S3ObjectStore({ ...options, fetch: s3.fetch });
    const started = await store.startUpload('backups/pc/b1.rpbk', 130 * MiB, 3_600);
    expect(started).toMatchObject({ uploadId: 'up-1', partSize: 64 * MiB });
    expect(started.parts.map((part) => part.number)).toEqual([1, 2, 3]);
    const part = new URL(started.parts[1]!.url);
    expect(part.host).toBe('rp-backups.s3.ap-south-1.amazonaws.com');
    expect(part.pathname).toBe('/backups/pc/b1.rpbk');
    expect(part.searchParams.get('partNumber')).toBe('2');
    expect(part.searchParams.get('uploadId')).toBe('up-1');
    expect(part.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(part.searchParams.get('X-Amz-Credential')).toMatch(/\/ap-south-1\/s3\/aws4_request$/);

    await store.completeUpload('backups/pc/b1.rpbk', 'up-1', [
      { number: 2, etag: '"b"' },
      { number: 1, etag: '"a"' },
    ]);
    const complete = s3.calls.at(-1)!;
    expect(complete.url.searchParams.get('uploadId')).toBe('up-1');
    expect(complete.body).toBe(
      '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&#34;a&#34;</ETag></Part>' +
        '<Part><PartNumber>2</PartNumber><ETag>&#34;b&#34;</ETag></Part></CompleteMultipartUpload>',
    );
    expect(complete.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
    expect(complete.headers.get('x-amz-content-sha256')).toBe(
      createHash('sha256').update(complete.body).digest('hex'),
    );
  });

  it('treats an error inside a 200 answer as an error, and a missing object as none', async () => {
    const s3 = fakeS3((method) =>
      method === 'HEAD'
        ? new Response(null, { status: 404 })
        : new Response('<Error><Code>InternalError</Code><Message>Try again</Message></Error>'),
    );
    const store = new S3ObjectStore({ ...options, fetch: s3.fetch, pathStyle: true });
    await expect(store.completeUpload('k', 'up', [{ number: 1, etag: 'x' }])).rejects.toEqual(
      new S3Error(200, 'InternalError', 'Try again'),
    );
    expect(s3.calls[0]?.url.toString()).toMatch(
      /^https:\/\/s3\.ap-south-1\.amazonaws\.com\/rp-backups\/k\?uploadId=up$/,
    );
    expect(await store.sizeOf('k')).toBeNull();
  });
});

describe('[DATA-003] the local store (development)', () => {
  it('takes parts by signed URL, checks their MD5 and joins them', async () => {
    const store = new LocalObjectStore(mkdtempSync(join(tmpdir(), 'cp-store-')), { partBytes: 4 });
    const started = await store.startUpload('backups/pc/b1.rpbk', 10, 60);
    expect(started.parts).toHaveLength(3);
    const grantOf = (url: string) => store.verify(url.split('/').at(-1)!);
    const bytes = Buffer.from('0123456789');
    const etags = [];
    for (const part of started.parts) {
      const chunk = bytes.subarray((part.number - 1) * 4, part.number * 4);
      const md5 = createHash('md5').update(chunk).digest('base64');
      etags.push({
        number: part.number,
        etag: await store.putPart(grantOf(part.url)!, Readable.from([chunk]), md5),
      });
    }
    await store.completeUpload('backups/pc/b1.rpbk', started.uploadId, etags);
    expect(await store.sizeOf('backups/pc/b1.rpbk')).toBe(10);
    expect(await store.keys()).toEqual(['backups/pc/b1.rpbk']);
    const download = store.verify(
      (await store.downloadUrl('backups/pc/b1.rpbk', 60)).split('/').at(-1)!,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of store.open(download!)) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('0123456789');

    // A part whose bytes do not match its Content-MD5 is refused.
    const again = await store.startUpload('backups/pc/b2.rpbk', 4, 60);
    await expect(
      store.putPart(grantOf(again.parts[0]!.url)!, Readable.from([Buffer.from('abcd')]), 'AAAA'),
    ).rejects.toBeInstanceOf(BadDigestError);
    await store.remove('backups/pc/b1.rpbk');
    expect(await store.sizeOf('backups/pc/b1.rpbk')).toBeNull();
  });

  it('refuses a changed, foreign or expired grant', async () => {
    let now = new Date('2026-10-03T00:00:00Z');
    const folder = mkdtempSync(join(tmpdir(), 'cp-store-'));
    const store = new LocalObjectStore(folder, { now: () => now });
    const url = await store.downloadUrl('backups/pc/b1.rpbk', 60);
    const token = url.split('/').at(-1)!;
    expect(store.verify(token)).toMatchObject({ op: 'GET', key: 'backups/pc/b1.rpbk' });
    const [body, mac] = token.split('.');
    const other = Buffer.from(
      Buffer.from(body!, 'base64url').toString().replace('b1', 'b2'),
    ).toString('base64url');
    expect(store.verify(`${other}.${mac!}`)).toBeNull();
    expect(new LocalObjectStore(folder).verify(token)).toBeNull();
    now = new Date('2026-10-03T00:02:00Z');
    expect(store.verify(token)).toBeNull();
  });
});

describe('[DATA-003] where cloud backups may be kept', () => {
  const base = {
    DATABASE_URL: 'postgresql://cp@db.example.in/cp?sslmode=require',
    CP_ENV: 'production',
    CP_TRUST_PROXY: '1',
    CP_SECRET_KEY: randomBytes(32).toString('base64'),
    CP_BACKUP_S3_BUCKET: 'rp-backups',
    CP_BACKUP_S3_ACCESS_KEY_ID: 'AKIA',
    CP_BACKUP_S3_SECRET_ACCESS_KEY: 'secret',
  };

  it('keeps them in S3 in India in production', () => {
    expect(loadConfig({ ...base, CP_BACKUP_STORE: 's3' }).backupS3Region).toBe('ap-south-1');
    expect(() =>
      loadConfig({ ...base, CP_BACKUP_STORE: 's3', CP_BACKUP_S3_REGION: 'us-east-1' }),
    ).toThrow(/must stay in India/);
    expect(() =>
      loadConfig({ ...base, CP_BACKUP_STORE: 'local', CP_BACKUP_LOCAL_DIR: '/x' }),
    ).toThrow(/S3/);
    expect(() => loadConfig({ ...base, CP_BACKUP_STORE: 's3', CP_BACKUP_S3_BUCKET: '' })).toThrow(
      /CP_BACKUP_S3_BUCKET/,
    );
  });

  it('is off by default, and a folder in development', () => {
    const development = { DATABASE_URL: 'postgresql://cp@localhost/cp' };
    expect(loadConfig(development).backupStore).toBe('off');
    expect(() => loadConfig({ ...development, CP_BACKUP_STORE: 'local' })).toThrow(
      /CP_BACKUP_LOCAL_DIR/,
    );
  });
});
