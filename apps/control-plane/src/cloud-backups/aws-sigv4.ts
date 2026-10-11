import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 (P7-05d): the requests to S3-compatible object storage and to KMS in
 * the India region, signed by hand so the Control Plane needs no SDK. Checked against the
 * examples in AWS's S3 documentation.
 */

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** For temporary credentials (an instance role). */
  readonly sessionToken?: string;
}

export const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/** RFC 3986 encoding, as SigV4 wants it; `/` kept in paths. */
export function awsEncode(value: string, keepSlash = false): string {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return keepSlash ? encoded.replaceAll('%2F', '/') : encoded;
}

/** `20130524T000000Z` */
export function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function signingKey(secret: string, day: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), 'aws4_request');
}

function canonicalQuery(query: Readonly<Record<string, string>>): string {
  return Object.entries(query)
    .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

export interface SignInput {
  readonly method: string;
  readonly url: URL;
  /** Header names in any case; `host` is added from the URL. */
  readonly headers?: Record<string, string>;
  /** Hex SHA-256 of the body, or UNSIGNED-PAYLOAD. */
  readonly payloadHash: string;
  readonly region: string;
  readonly service: string;
  readonly credentials: AwsCredentials;
  readonly now: Date;
}

function canonical(
  input: SignInput,
  query: Record<string, string>,
  headers: Record<string, string>,
) {
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const lower = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const canonicalHeaders = names
    .map((name) => `${name}:${(lower[name] ?? '').trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = names.join(';');
  const path = input.url.pathname
    .split('/')
    .map((part) => awsEncode(decodeURIComponent(part)))
    .join('/');
  const request = [
    input.method.toUpperCase(),
    path === '' ? '/' : path,
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');
  return { request, signedHeaders };
}

function stringToSign(input: SignInput, canonicalRequest: string): string {
  const day = amzDate(input.now).slice(0, 8);
  return [
    'AWS4-HMAC-SHA256',
    amzDate(input.now),
    `${day}/${input.region}/${input.service}/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join('\n');
}

function signature(input: SignInput, toSign: string): string {
  const day = amzDate(input.now).slice(0, 8);
  return createHmac(
    'sha256',
    signingKey(input.credentials.secretAccessKey, day, input.region, input.service),
  )
    .update(toSign, 'utf8')
    .digest('hex');
}

/** Signs a request with an Authorization header; returns the headers to send. */
export function signHeaders(input: SignInput): Record<string, string> {
  const headers: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    'x-amz-date': amzDate(input.now),
    ...(input.service === 's3' && { 'x-amz-content-sha256': input.payloadHash }),
    ...(input.credentials.sessionToken !== undefined && {
      'x-amz-security-token': input.credentials.sessionToken,
    }),
  };
  const query = Object.fromEntries(input.url.searchParams.entries());
  const { request, signedHeaders } = canonical(input, query, headers);
  const day = amzDate(input.now).slice(0, 8);
  const credential = `${input.credentials.accessKeyId}/${day}/${input.region}/${input.service}/aws4_request`;
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature(input, stringToSign(input, request))}`,
  };
}

/** A presigned URL (query-string authentication), valid for `expiresSeconds`. */
export function presignUrl(
  input: Omit<SignInput, 'payloadHash'> & { readonly expiresSeconds: number },
): string {
  const day = amzDate(input.now).slice(0, 8);
  const query: Record<string, string> = {
    ...Object.fromEntries(input.url.searchParams.entries()),
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${input.credentials.accessKeyId}/${day}/${input.region}/${input.service}/aws4_request`,
    'X-Amz-Date': amzDate(input.now),
    'X-Amz-Expires': String(input.expiresSeconds),
    'X-Amz-SignedHeaders': 'host',
    ...(input.credentials.sessionToken !== undefined && {
      'X-Amz-Security-Token': input.credentials.sessionToken,
    }),
  };
  const signInput: SignInput = { ...input, payloadHash: UNSIGNED_PAYLOAD };
  const { request } = canonical(signInput, query, { host: input.url.host });
  const signed = signature(signInput, stringToSign(signInput, request));
  const url = new URL(input.url.toString());
  url.search = `${canonicalQuery(query)}&X-Amz-Signature=${signed}`;
  return url.toString();
}
