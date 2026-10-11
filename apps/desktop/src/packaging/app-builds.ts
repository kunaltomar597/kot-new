import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  APP_BUILD_KINDS,
  APP_BUILDS_FILE,
  type AppBuildKind,
  AppBuildsFile,
  CLIENT_API_VERSION,
} from '@rp/contracts';

/** The name the release pipeline gives each APK in the `--apk` folder: `waiter-app.apk`. */
export function apkFileName(kind: AppBuildKind): string {
  return `${kind}.apk`;
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function appVersion(repoRoot: string, kind: AppBuildKind): Promise<string> {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'apps', kind, 'package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

/**
 * The release's phone and tablet APKs in the payload's `apps` folder, with `apps.json` (P7-04e2,
 * WTR-001, ADR-0017). `apkDir` holds the EAS production builds, signed with the app-signing key:
 * `waiter-app.apk` and `table-tablet.apk`. Each is copied as `<kind>-<version>.apk` with its size
 * and SHA-256; its version is the app's `package.json`'s, which the build took, and the client API
 * is this commit's. The restaurant PC checks each APK against `apps.json` before offering it, and
 * the phone checks it again, with its package and version, before Android installs it. Without
 * `apkDir` the release carries none and `apps.json` lists none.
 */
export async function stageAppBuilds(options: {
  readonly repoRoot: string;
  readonly release: string;
  readonly apkDir: string | undefined;
  /** The payload's `apps` folder. */
  readonly target: string;
}): Promise<AppBuildsFile> {
  await mkdir(options.target, { recursive: true });
  const apps: AppBuildsFile['apps'][number][] = [];
  if (options.apkDir !== undefined) {
    const known = new Set<string>(APP_BUILD_KINDS.map(apkFileName));
    const names = (await readdir(options.apkDir)).filter((name) => name.endsWith('.apk'));
    const unknown = names.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown APKs in ${options.apkDir}: ${unknown.join(', ')} (expected ${[...known].join(', ')})`,
      );
    }
    if (names.length === 0) throw new Error(`No APKs in ${options.apkDir}`);
    for (const kind of APP_BUILD_KINDS) {
      const source = join(options.apkDir, apkFileName(kind));
      if (!names.includes(apkFileName(kind))) continue;
      const version = await appVersion(options.repoRoot, kind);
      const file = `${kind}-${version}.apk`;
      await copyFile(source, join(options.target, file));
      apps.push({
        kind,
        version,
        clientApi: CLIENT_API_VERSION,
        file,
        sha256: await sha256Of(source),
        sizeBytes: (await stat(source)).size,
      });
    }
  }
  const manifest = AppBuildsFile.parse({ format: 1, release: options.release, apps });
  await writeFile(join(options.target, APP_BUILDS_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
