// Writes the vendor menu template (P1-05, ONB-005): `pnpm --filter @rp/server menu:template [path]`.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { buildMenuTemplate } from './menu-template.js';

const target = resolve(process.argv[2] ?? '../../docs/onboarding/menu-template.xlsx');
await mkdir(dirname(target), { recursive: true });
await writeFile(target, await buildMenuTemplate());
process.stdout.write(`Wrote ${target}\n`);
