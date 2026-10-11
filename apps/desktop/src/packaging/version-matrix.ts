import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CLIENT_API_HISTORY,
  CLIENT_API_VERSION,
  PAGER_PROTOCOL_VERSION,
  VersionMatrix,
} from '@rp/contracts';
import { buildVersionMatrix } from '@rp/domain';
import { NODE, POSTGRES, WINSW } from './components.js';

/** Beside the staged installer and in the payload (the install folder), for support. */
export const VERSION_MATRIX_FILE = 'version-matrix.json';

async function packageVersion(repoRoot: string, app: string): Promise<string> {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'apps', app, 'package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

/**
 * The component version matrix of a release (UPD-006, P7-04d): what the installer contains and
 * runs on, the client API its server serves, and each app's build in the repository with the
 * oldest build the server still serves. The release pipeline publishes it with the release
 * (`release:publish --matrix`). Each app's version is its `package.json`'s (the Expo apps read
 * theirs from it too).
 */
export async function versionMatrix(repoRoot: string, release: string): Promise<VersionMatrix> {
  const [server, consoleVersion, waiter, tablet] = await Promise.all([
    packageVersion(repoRoot, 'server'),
    packageVersion(repoRoot, 'console'),
    packageVersion(repoRoot, 'waiter-app'),
    packageVersion(repoRoot, 'table-tablet'),
  ]);
  return VersionMatrix.parse(
    buildVersionMatrix({
      release,
      clientApi: CLIENT_API_VERSION,
      history: CLIENT_API_HISTORY,
      components: [
        { name: 'server', version: server },
        { name: 'console', version: consoleVersion },
        { name: 'desktop', version: release },
        { name: 'node', version: NODE.version },
        { name: 'postgres', version: POSTGRES.version },
        { name: 'winsw', version: WINSW.version },
      ],
      clients: [
        { kind: 'console', version: consoleVersion },
        { kind: 'waiter-app', version: waiter },
        { kind: 'table-tablet', version: tablet },
      ],
      pagerProtocol: PAGER_PROTOCOL_VERSION,
    }),
  );
}
