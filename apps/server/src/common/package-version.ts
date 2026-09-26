import { readFileSync } from 'node:fs';

export interface PackageVersion {
  readonly name: string;
  readonly version: string;
}

function readPackageVersion(): PackageVersion {
  const fallback = { name: '@rp/server', version: '0.0.0' };
  try {
    // Resolves to apps/server/package.json from both src/common and dist/common. A missing or
    // unreadable file (for example a different installer layout) must never stop the server.
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
    return {
      name: typeof parsed.name === 'string' ? parsed.name : fallback.name,
      version: typeof parsed.version === 'string' ? parsed.version : fallback.version,
    };
  } catch {
    return fallback;
  }
}

/** The server package's name and version (GET /version, heartbeats). */
export const SERVER_PACKAGE: PackageVersion = readPackageVersion();
