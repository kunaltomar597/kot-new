import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Component } from './components.js';

/**
 * Downloads of the bundled programs (P0-16d), kept in a cache folder and checked against their
 * pinned SHA-256 every time they are used, so a cached file that changed is caught too.
 */

export async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** The download's name in the cache: the last part of its address. */
export function cachePathOf(component: Component, cacheDir: string): string {
  return join(cacheDir, basename(new URL(component.url).pathname));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class ChecksumError extends Error {
  constructor(
    readonly component: Component,
    readonly actual: string,
  ) {
    super(
      `${component.url} has SHA-256 ${actual}, not the pinned ${component.sha256}. If the new ` +
        'version is wanted, update its version, address and hash together in components.ts.',
    );
    this.name = 'ChecksumError';
  }
}

/**
 * The component's file in the cache, downloaded if it is not there or does not match. Throws
 * ChecksumError, leaving nothing in the cache, when the download does not match either.
 */
export async function fetchVerified(
  component: Component,
  cacheDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const path = cachePathOf(component, cacheDir);
  if ((await exists(path)) && (await sha256Of(path)) === component.sha256) return path;

  await mkdir(cacheDir, { recursive: true });
  const response = await fetchImpl(component.url, { redirect: 'follow' });
  if (!response.ok || response.body === null) {
    throw new Error(`Downloading ${component.url} failed: HTTP ${response.status}`);
  }
  const partial = `${path}.part`;
  const hash = createHash('sha256');
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), hashing, createWriteStream(partial));
    const actual = hash.digest('hex');
    if (actual !== component.sha256) throw new ChecksumError(component, actual);
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
  return path;
}
