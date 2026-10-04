import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Arch, build, Platform } from 'electron-builder';
import { builderConfig } from './builder-config.js';
import { stagingLayout } from './payload.js';
import { readManifest } from './stage.js';

/**
 * `pnpm --filter @rp/desktop package:win [--any-platform]` (P0-16d): the Windows installer from
 * apps/desktop/staging, into apps/desktop/release. It signs when the certificate is given
 * (WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD, from a CI secret). A payload staged off Windows has
 * native modules Windows cannot load, so it is refused unless --any-platform (to check that the
 * installer script builds).
 */

const projectDir = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: { 'any-platform': { type: 'boolean' } } });
const staging = stagingLayout(join(projectDir, 'staging'));
const manifest = await readManifest(staging.root);
if (manifest.platform !== 'win32' && values['any-platform'] !== true) {
  throw new Error(
    `The payload was staged on ${manifest.platform}; stage it on Windows, or pass --any-platform to build a test installer.`,
  );
}
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
    version: manifest.productVersion,
    electronVersion,
    editExecutable: process.platform === 'win32',
  }),
});
process.stdout.write(`${artifacts.join('\n')}\n`);
