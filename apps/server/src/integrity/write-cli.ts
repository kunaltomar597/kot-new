import { writeIntegrityManifest } from './server-files.js';

/** `node dist/integrity/write-cli.js <server folder>`: the installer build lists the files (LIC-007). */
const folder = process.argv[2];
if (folder === undefined) {
  process.stderr.write('Usage: node dist/integrity/write-cli.js <server folder>\n');
  process.exit(2);
}
const manifest = await writeIntegrityManifest(folder);
process.stdout.write(`Listed ${Object.keys(manifest.files).length} files.\n`);
