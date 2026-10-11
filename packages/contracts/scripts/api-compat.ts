/**
 * The client API's backward compatibility (UPD-006, P7-04d; docs/runbooks/client-compatibility.md):
 *
 *   pnpm contracts:compat                    the contracts still serve every frozen client API
 *                                            version the server serves (CLIENT_API_VERSION and
 *                                            the one before it); exit 1 when they do not (CI)
 *   pnpm contracts:freeze --release <x.y.z>  at a release: freeze CLIENT_API_VERSION into
 *                                            docs/api/compat/, or say that it must go up first
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareClientApi,
  formatClientApiVersion,
  oldestServedClientApi,
  parseClientApiVersion,
  parseVersion,
} from '@rp/domain';
import * as contracts from '../src/index.js';
import { buildAsyncApi } from './lib/asyncapi.js';
import { type ApiSnapshot, compatibilityProblems, sameApi, snapshotOf } from './lib/compat.js';
import { buildOpenApi } from './lib/openapi.js';

const compatDir = fileURLToPath(new URL('../../../docs/api/compat/', import.meta.url));
const FILE = /^client-api-(\d+\.\d+)\.json$/;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const currentVersion = parseClientApiVersion(contracts.CLIENT_API_VERSION);
if (currentVersion === undefined) fail(`CLIENT_API_VERSION is not <major>.<minor>.`);

const current = snapshotOf({
  api: contracts.CLIENT_API_VERSION,
  release: null,
  openapi: buildOpenApi({ namespace: contracts, routes: contracts.ROUTES, version: '0.0.0' }),
  asyncapi: buildAsyncApi({
    namespace: contracts,
    events: contracts.DomainEvent,
    version: '0.0.0',
  }),
});

const frozen: ApiSnapshot[] = [];
for (const name of await readdir(compatDir).catch(() => [] as string[])) {
  if (!FILE.test(name)) continue;
  frozen.push(JSON.parse(await readFile(join(compatDir, name), 'utf8')) as ApiSnapshot);
}

const oldest = oldestServedClientApi(currentVersion);
const served: ApiSnapshot[] = [];
for (const snapshot of frozen) {
  const version = parseClientApiVersion(snapshot.api);
  if (version === undefined)
    fail(`docs/api/compat: "${snapshot.api}" is not a client API version.`);
  if (compareClientApi(version, currentVersion) > 0) {
    fail(
      `Client API ${snapshot.api} is frozen but CLIENT_API_VERSION is ` +
        `${contracts.CLIENT_API_VERSION}: it may only go up.`,
    );
  }
  if (compareClientApi(version, oldest) >= 0) served.push(snapshot);
}

const problems = served.flatMap((snapshot) =>
  compatibilityProblems(snapshot, current).map(
    (problem) => `client API ${snapshot.api} (release ${snapshot.release ?? '?'}): ${problem}`,
  ),
);

const servedText =
  compareClientApi(oldest, currentVersion) === 0
    ? contracts.CLIENT_API_VERSION
    : `${formatClientApiVersion(oldest)} and ${contracts.CLIENT_API_VERSION}`;

if (process.argv.includes('--freeze')) {
  const release = argument('--release');
  if (release === undefined || parseVersion(release) === undefined) {
    fail('Usage: pnpm contracts:freeze --release <x.y.z>');
  }
  const api = contracts.CLIENT_API_VERSION;
  const existing = frozen.find((snapshot) => snapshot.api === api);
  if (existing !== undefined) {
    if (sameApi(existing, current)) {
      process.stdout.write(
        `Client API ${api} was frozen at release ${existing.release ?? '?'} and has not ` +
          'changed: nothing to freeze.\n',
      );
      process.exit(0);
    }
    const next = formatClientApiVersion({ ...currentVersion, minor: currentVersion.minor + 1 });
    fail(
      `The contracts changed since client API ${api} was frozen at release ` +
        `${existing.release ?? '?'}. In packages/contracts/src/client-api.ts set ` +
        `CLIENT_API_VERSION to '${next}' and add { api: '${next}', since: '${release}' } to ` +
        'CLIENT_API_HISTORY, then run this again.',
    );
  }
  const entry = contracts.CLIENT_API_HISTORY.find((item) => item.api === api);
  if (entry?.since !== release) {
    fail(
      `Add { api: '${api}', since: '${release}' } to CLIENT_API_HISTORY in ` +
        'packages/contracts/src/client-api.ts (the release that first ships it), then run ' +
        'this again.',
    );
  }
  if (problems.length > 0) {
    fail(`The contracts break apps still served:\n- ${problems.join('\n- ')}`);
  }
  await mkdir(compatDir, { recursive: true });
  await writeFile(
    join(compatDir, `client-api-${api}.json`),
    `${JSON.stringify({ ...current, release })}\n`,
  );
  process.stdout.write(`Froze client API ${api} at release ${release} in docs/api/compat/.\n`);
} else if (problems.length > 0) {
  fail(
    `The contracts no longer serve apps on client API ${servedText} (UPD-006):\n- ` +
      `${problems.join('\n- ')}\n` +
      'Keep the old shape alongside the new one, or see docs/runbooks/client-compatibility.md.',
  );
} else {
  const checked = served.map((snapshot) => snapshot.api).join(', ');
  process.stdout.write(
    served.length === 0
      ? `Client API ${servedText} is not frozen yet: nothing to compare.\n`
      : `The contracts still serve client API ${checked}.\n`,
  );
}
