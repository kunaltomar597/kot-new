import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Downloads an update installer in the background (UPD-004) over HTTPS only (UPD-007), to a
 * partial file renamed once its size and SHA-256 match the release. A redirect to plain HTTP is
 * refused; a download that grows past the release's size is cut off.
 */

export type UpdateDownloadProblem = 'NOT_HTTPS' | 'HTTP_STATUS' | 'SIZE' | 'HASH' | 'NETWORK';

export class UpdateDownloadError extends Error {
  constructor(
    readonly problem: UpdateDownloadProblem,
    message: string,
  ) {
    super(message);
    this.name = 'UpdateDownloadError';
  }
}

export interface DownloadOptions {
  readonly url: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  /** The installer's final path. */
  readonly target: string;
  readonly fetch?: typeof fetch;
  /** The whole download, which is large: 30 minutes by default. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export async function downloadInstaller(options: DownloadOptions): Promise<void> {
  if (!isHttps(options.url)) {
    throw new UpdateDownloadError('NOT_HTTPS', 'Updates are downloaded over HTTPS only.');
  }
  const signals = [AbortSignal.timeout(options.timeoutMs ?? 30 * 60_000)];
  if (options.signal !== undefined) signals.push(options.signal);
  const signal = AbortSignal.any(signals);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(options.url, { redirect: 'follow', signal });
  } catch (error) {
    throw new UpdateDownloadError(
      'NETWORK',
      `The download could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Redirects are followed; where they ended must be HTTPS too.
  if (response.url !== '' && !isHttps(response.url)) {
    await response.body?.cancel();
    throw new UpdateDownloadError('NOT_HTTPS', 'The download was redirected away from HTTPS.');
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new UpdateDownloadError(
      'HTTP_STATUS',
      `The download was refused (HTTP ${String(response.status)}).`,
    );
  }
  const partial = `${options.target}.partial`;
  await mkdir(dirname(options.target), { recursive: true });
  const hash = createHash('sha256');
  let received = 0;
  const counting = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > options.sizeBytes) {
        callback(new UpdateDownloadError('SIZE', 'The download is larger than the release says.'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), counting, createWriteStream(partial), {
      signal,
    });
  } catch (error) {
    await rm(partial, { force: true });
    if (error instanceof UpdateDownloadError) throw error;
    throw new UpdateDownloadError(
      'NETWORK',
      `The download was cut off: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (received !== options.sizeBytes) {
    await rm(partial, { force: true });
    throw new UpdateDownloadError(
      'SIZE',
      `The download is ${String(received)} bytes; the release says ${String(options.sizeBytes)}.`,
    );
  }
  if (hash.digest('hex') !== options.sha256) {
    await rm(partial, { force: true });
    throw new UpdateDownloadError('HASH', 'The download does not match the release’s SHA-256.');
  }
  await rename(partial, options.target);
}

/** Whether a downloaded installer is still the release's: its size and SHA-256 (UPD-007). */
export async function installerMatches(
  path: string,
  expected: { readonly sha256: string; readonly sizeBytes: number },
): Promise<boolean> {
  try {
    if ((await stat(path)).size !== expected.sizeBytes) return false;
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), hash);
    return hash.digest('hex') === expected.sha256;
  } catch {
    return false;
  }
}
