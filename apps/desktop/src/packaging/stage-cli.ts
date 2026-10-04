import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stage } from './stage.js';

/**
 * `pnpm --filter @rp/desktop package:stage [--version 1.2.3] [--cache <folder>]` (P0-16d): stages
 * the installer's contents in apps/desktop/staging after `pnpm build`. The vendor's addresses
 * come from RP_CONTROL_PLANE_URL, RP_RELAY_URL, RP_QR_SITE_URL and RP_ERROR_DSN.
 */

const projectDir = fileURLToPath(new URL('../../', import.meta.url));
const repoRoot = join(projectDir, '..', '..');
const { values } = parseArgs({
  options: { version: { type: 'string' }, cache: { type: 'string' } },
});
const ownVersion = (
  JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as { version: string }
).version;

const manifest = await stage({
  repoRoot,
  version: values.version ?? process.env.RP_PRODUCT_VERSION ?? ownVersion,
  cacheDir: values.cache ?? join(repoRoot, 'node_modules', '.cache', 'rp-installer'),
  env: process.env,
  log: (message) => process.stdout.write(`${message}\n`),
});
process.stdout.write(`Staged ${manifest.productVersion} for ${manifest.platform}.\n`);
