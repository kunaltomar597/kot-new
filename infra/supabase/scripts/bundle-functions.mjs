// Bundles each relay function for Supabase Edge Functions (Deno): src/entries/<name>.ts and
// everything it imports (contracts, the shared line check, zod) into dist/functions/<name>/index.js.
// Only the database driver stays an `npm:` import, which Deno loads at run time.
import { build } from 'esbuild';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = process.argv[2] ?? join(root, 'dist', 'functions');

export const FUNCTIONS = readdirSync(join(root, 'src', 'entries'))
  .filter((file) => file.endsWith('.ts'))
  .map((file) => file.slice(0, -'.ts'.length))
  .sort();

for (const name of FUNCTIONS) {
  await build({
    entryPoints: [join(root, 'src', 'entries', `${name}.ts`)],
    outfile: join(outRoot, name, 'index.js'),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    mainFields: ['module', 'main'],
    conditions: ['import'],
    external: ['npm:*'],
    legalComments: 'eof',
    // zod's namespace keeps every locale; minifying keeps cold starts quick.
    minify: true,
    logLevel: 'warning',
  });
}
