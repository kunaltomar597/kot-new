import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Arch, build, Platform } from 'electron-builder';
import { builderConfig } from './builder-config.js';
import { stagingLayout } from './payload.js';
import { releaseRefusals, signedBuild, stagedKeys, stagedUpdateSettings } from './release-guard.js';
import { readManifest } from './stage.js';

/**
 * `pnpm --filter @rp/desktop package:win [--any-platform]` (P0-16d): the Windows installer from
 * apps/desktop/staging, into apps/desktop/release. It signs when the certificate is given
 * (WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD, from a CI secret). A payload staged off Windows has
 * native modules Windows cannot load, so it is refused unless --any-platform (to check that the
 * installer script builds), and always for a signed build; `release-guard.ts` says what else a
 * signed build needs. `--product-version` builds the same payload as another version.
 */

const projectDir = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({
  options: { 'any-platform': { type: 'boolean' }, 'product-version': { type: 'string' } },
});
const staging = stagingLayout(join(projectDir, 'staging'));
const manifest = await readManifest(staging.root);
// The release guard (UPD-007, LIC-003, PGR-011): a signed build checks its updates' signer, never
// takes unsigned ones, is staged on Windows and carries the vendor's keys.
const refusals = releaseRefusals({
  signed: signedBuild(process.env),
  updates: stagedUpdateSettings(readFileSync(staging.nsisDefines, 'utf8')),
  stagedOn: manifest.platform,
  anyPlatform: values['any-platform'] === true,
  keys: await stagedKeys(staging.payload),
});
if (refusals.length > 0) throw new Error(refusals.join('\n'));
const electronVersion = (
  JSON.parse(
    readFileSync(join(projectDir, 'node_modules', 'electron', 'package.json'), 'utf8'),
  ) as { version: string }
).version;

const artifacts = await build({
  projectDir,
  targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
  config: builderConfig({
    projectDir,
    staging,
    outputDir: join(projectDir, 'release'),
    // `--product-version`: the same payload as another version (the CI job's update test, P7-04c).
    version: values['product-version'] ?? manifest.productVersion,
    electronVersion,
    editExecutable: process.platform === 'win32',
  }),
});
process.stdout.write(`${artifacts.join('\n')}\n`);
