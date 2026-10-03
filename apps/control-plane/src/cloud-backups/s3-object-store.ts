import {
  type AwsCredentials,
  EMPTY_SHA256,
  presignUrl,
  sha256Hex,
  signHeaders,
} from './aws-sigv4.js';
import { type ObjectStore, partCount, partSizeFor, type StartedUpload } from './object-store.js';

export interface S3Options {
  /** e.g. https://s3.ap-south-1.amazonaws.com, or an S3-compatible service's address. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly credentials: AwsCredentials;
  /** `https://endpoint/bucket/key` instead of `https://bucket.endpoint/key`. */
  readonly pathStyle?: boolean;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

function encodeKey(key: string): string {
  return key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function xmlValue(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];
}

function xmlEscape(text: string): string {
  return text.replace(/[<>&'"]/g, (c) => `&#${String(c.charCodeAt(0))};`);
}

export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'S3Error';
  }
}

/** S3 (or an S3-compatible service), signed with SigV4 (P7-05d). */
export class S3ObjectStore implements ObjectStore {
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: S3Options) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  private urlOf(key: string, query: Record<string, string> = {}): URL {
    const base = new URL(this.options.endpoint);
    const url =
      this.options.pathStyle === true
        ? new URL(`${base.origin}/${this.options.bucket}/${encodeKey(key)}`)
        : new URL(`${base.protocol}//${this.options.bucket}.${base.host}/${encodeKey(key)}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  }

  private async send(
    method: string,
    url: URL,
    body = '',
  ): Promise<{ status: number; text: string; headers: Headers }> {
    const headers = signHeaders({
      method,
      url,
      headers: body === '' ? {} : { 'content-type': 'application/xml' },
      payloadHash: body === '' ? EMPTY_SHA256 : sha256Hex(body),
      region: this.options.region,
      service: 's3',
      credentials: this.options.credentials,
      now: this.now(),
    });
    delete headers.host;
    const response = await this.fetch(url, { method, headers, ...(body !== '' && { body }) });
    const text = await response.text();
    // S3 can answer 200 with an error inside (CompleteMultipartUpload).
    const code = xmlValue(text, 'Code');
    if (!response.ok || (text.includes('<Error>') && code !== undefined)) {
      throw new S3Error(
        response.status,
        code ?? 'S3_ERROR',
        xmlValue(text, 'Message') ?? `S3 answered ${String(response.status)}`,
      );
    }
    return { status: response.status, text, headers: response.headers };
  }

  async startUpload(
    key: string,
    sizeBytes: number,
    expiresSeconds: number,
  ): Promise<StartedUpload> {
    const { text } = await this.send('POST', this.urlOf(key, { uploads: '' }));
    const uploadId = xmlValue(text, 'UploadId');
    if (uploadId === undefined)
      throw new S3Error(502, 'NO_UPLOAD_ID', 'S3 did not start the upload');
    const partSize = partSizeFor(sizeBytes);
    const parts = Array.from({ length: partCount(sizeBytes, partSize) }, (_, index) => ({
      number: index + 1,
      url: presignUrl({
        method: 'PUT',
        url: this.urlOf(key, { partNumber: String(index + 1), uploadId }),
        region: this.options.region,
        service: 's3',
        credentials: this.options.credentials,
        now: this.now(),
        expiresSeconds,
      }),
    }));
    return { uploadId, partSize, parts };
  }

  async completeUpload(
    key: string,
    uploadId: string,
    parts: readonly { number: number; etag: string }[],
  ): Promise<void> {
    const body = `<CompleteMultipartUpload>${[...parts]
      .sort((a, b) => a.number - b.number)
      .map(
        (part) =>
          `<Part><PartNumber>${String(part.number)}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`,
      )
      .join('')}</CompleteMultipartUpload>`;
    await this.send('POST', this.urlOf(key, { uploadId }), body);
  }

  async abortUpload(key: string, uploadId: string): Promise<void> {
    await this.send('DELETE', this.urlOf(key, { uploadId })).catch((error: unknown) => {
      if (error instanceof S3Error && error.status === 404) return;
      throw error;
    });
  }

  async sizeOf(key: string): Promise<number | null> {
    try {
      const { headers } = await this.send('HEAD', this.urlOf(key));
      return Number(headers.get('content-length') ?? 0);
    } catch (error) {
      if (error instanceof S3Error && error.status === 404) return null;
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await this.send('DELETE', this.urlOf(key));
  }

  downloadUrl(key: string, expiresSeconds: number): Promise<string> {
    return Promise.resolve(
      presignUrl({
        method: 'GET',
        url: this.urlOf(key),
        region: this.options.region,
        service: 's3',
        credentials: this.options.credentials,
        now: this.now(),
        expiresSeconds,
      }),
    );
  }
}
