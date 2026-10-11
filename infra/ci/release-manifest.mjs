#!/usr/bin/env node
// Release evidence (SEC-013, threat model "The update pipeline", UPDATE-R3): writes
// `release-manifest.json`, which names the commit and the CI run that built a release and the
// SHA-256 of every file that belongs to it (the signed installer, its component version matrix and
// its SBOM). The workflow then attests those files, so anyone can check with
// `gh attestation verify <installer> --repo <owner/repo>` which commit and which run made them.
//
// Usage: node infra/ci/release-manifest.mjs --version 0.1.0 --commit <sha> --run <id>
//          --repository owner/repo --out release-manifest.json <file>...
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

/** The manifest of a release, or an error naming what is missing: it never guesses a field. */
export function buildReleaseManifest({ version, commit, run, repository, files }) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version ?? '')) throw new Error(`version "${version}"`);
  if (!COMMIT.test(commit ?? '')) throw new Error(`commit "${commit}" is not a full commit`);
  if (!/^\d+$/.test(run ?? '')) throw new Error(`run "${run}"`);
  if (!REPOSITORY.test(repository ?? '')) throw new Error(`repository "${repository}"`);
  if (!Array.isArray(files) || files.length === 0) throw new Error('no files');
  const names = new Set();
  for (const file of files) {
    if (names.has(file.name)) throw new Error(`${file.name} twice`);
    names.add(file.name);
  }
  return {
    version,
    commit,
    run,
    repository,
    files: [...files]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, sha256 }) => ({ name, sha256 })),
  };
}

export function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function main(argv) {
  const options = {};
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) options[argv[i].slice(2)] = argv[++i];
    else paths.push(argv[i]);
  }
  const manifest = buildReleaseManifest({
    version: options.version,
    commit: options.commit,
    run: options.run,
    repository: options.repository,
    files: paths.map((path) => ({ name: basename(path), sha256: sha256Of(path) })),
  });
  writeFileSync(options.out ?? 'release-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
