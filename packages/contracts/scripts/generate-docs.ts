/**
 * Generates the published contract documents (INT-002, NFR-M06):
 *   docs/api/openapi.json                local REST API, from the route registry and every schema
 *   docs/api/control-plane.openapi.json  Vendor Control Plane API (ADR-0012)
 *   docs/api/asyncapi.yaml               domain events, from the event catalogue
 *
 * Usage: pnpm contracts:docs            write the files
 *        pnpm contracts:docs --check    exit 1 if the committed files are stale (CI)
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as controlPlane from '../src/control-plane/index.js';
import * as contracts from '../src/index.js';
import { renderDocs } from './lib/render.js';

const outDir = fileURLToPath(new URL('../../../docs/api/', import.meta.url));
const check = process.argv.includes('--check');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const files = await renderDocs({
  namespace: contracts,
  routes: contracts.ROUTES,
  events: contracts.DomainEvent,
  controlPlane: { namespace: controlPlane, routes: controlPlane.CONTROL_PLANE_ROUTES },
  version: pkg.version,
  outDir,
});

const stale: string[] = [];
await mkdir(outDir, { recursive: true });
for (const file of files) {
  const path = join(outDir, file.name);
  const current = await readFile(path, 'utf8').catch(() => undefined);
  if (current === file.content) continue;
  if (check) stale.push(`docs/api/${file.name}`);
  else await writeFile(path, file.content);
}

if (stale.length > 0) {
  process.stderr.write(
    `Contract docs are stale: ${stale.join(', ')}.\n` +
      "Run 'pnpm contracts:docs' and commit the result.\n",
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    check ? 'Contract docs are up to date.\n' : `Wrote contract docs to ${outDir}\n`,
  );
}
