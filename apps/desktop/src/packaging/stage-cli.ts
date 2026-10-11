import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stage } from './stage.js';

/**
 * `pnpm --filter @rp/desktop package:stage [--version 1.2.3] [--cache <folder>] [--apk <folder>]`
 * (P0-16d): stages the installer's contents in apps/desktop/staging after `pnpm build`. The
 * vendor's addresses come from RP_CONTROL_PLANE_URL, RP_RELAY_URL, RP_QR_SITE_URL and
 * RP_ERROR_DSN. `--apk` (or RP_APK_DIR) is the folder with the release's `waiter-app.apk` and
 * `table-tablet.apk`, which phones and tablets install from the PC (P7-04e2).
 */

const projectDir = fileURLToPath(new URL('../../', import.meta.url));
const repoRoot = join(projectDir, '..', '..');
const { values } = parseArgs({
  options: { version: { type: 'string' }, cache: { type: 'string' }, apk: { type: 'string' } },
});
const ownVersion = (
  JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as { version: string }
).version;

const fromEnv = process.env.RP_APK_DIR;
const apkDir = values.apk ?? (fromEnv === '' ? undefined : fromEnv);

const manifest = await stage({
  repoRoot,
  version: values.version ?? process.env.RP_PRODUCT_VERSION ?? ownVersion,
  cacheDir: values.cache ?? join(repoRoot, 'node_modules', '.cache', 'rp-installer'),
  env: process.env,
  ...(apkDir !== undefined && { apkDir }),
  log: (message) => process.stdout.write(`${message}\n`),
});
process.stdout.write(`Staged ${manifest.productVersion} for ${manifest.platform}.\n`);
