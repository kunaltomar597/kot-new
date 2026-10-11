// Run with `pnpm ci:test` (node:test; infra/ci is not a workspace package).
//
// Which commit and which build made a signed installer must be provable afterwards (threat model
// "The update pipeline", UPDATE-R3): the manifest names both and the files' hashes, and the
// release job attests them on main only, without the signing certificate.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildReleaseManifest } from './release-manifest.mjs';

const COMMIT = 'a'.repeat(40);
const base = {
  version: '0.1.0',
  commit: COMMIT,
  run: '123',
  repository: 'owner/repo',
  files: [
    { name: 'b.json', sha256: 'b'.repeat(64) },
    { name: 'a.exe', sha256: 'c'.repeat(64) },
  ],
};
const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const job = ci.slice(ci.indexOf('\n  release-evidence:'), ci.indexOf('\n  relay-supabase:'));

describe('[SEC-013] [UPDATE-R3] release evidence', () => {
  it('names the commit, the run and each file by its hash, in a fixed order', () => {
    const manifest = buildReleaseManifest(base);
    assert.equal(manifest.commit, COMMIT);
    assert.equal(manifest.run, '123');
    assert.deepEqual(
      manifest.files.map((file) => file.name),
      ['a.exe', 'b.json'],
    );
  });

  it('refuses a manifest without a full commit, a run, a repository or files', () => {
    for (const bad of [
      { commit: 'main' },
      { commit: undefined },
      { run: 'abc' },
      { repository: 'owner' },
      { version: 'latest' },
      { files: [] },
      { files: [base.files[0], base.files[0]] },
    ]) {
      assert.throws(() => buildReleaseManifest({ ...base, ...bad }));
    }
  });

  it('writes the SHA-256 of the files it is given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manifest-'));
    writeFileSync(join(dir, 'installer.exe'), 'abc');
    execFileSync(
      process.execPath,
      [
        new URL('./release-manifest.mjs', import.meta.url).pathname,
        ...['--version', '0.1.0', '--commit', COMMIT, '--run', '9', '--repository', 'o/r'],
        ...['--out', join(dir, 'm.json'), join(dir, 'installer.exe')],
      ],
      { cwd: dir },
    );
    const written = JSON.parse(readFileSync(join(dir, 'm.json'), 'utf8'));
    assert.equal(
      written.files[0].sha256,
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('attests the installer, the manifest and the SBOM in a job of main only, without the certificate', () => {
    assert.match(job, /attest-build-provenance@[0-9a-f]{40}/);
    assert.match(job, /needs: \[?windows-installer\]?/);
    assert.match(job, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
    assert.match(job, /id-token: write/);
    assert.match(job, /attestations: write/);
    assert.doesNotMatch(job, /WINDOWS_CERTIFICATE_|WIN_CSC_|environment:/);
    for (const file of ['RestaurantPlatform-Setup-', 'release-manifest.json', 'sbom.cdx.json']) {
      assert.ok(job.includes(file), file);
    }
  });
});

describe('[SEC-013] [UPDATE-R3] the SBOM generator', () => {
  it('is the same version in the release job and in the security workflow', () => {
    const security = readFileSync(
      new URL('../../.github/workflows/security.yml', import.meta.url),
      'utf8',
    );
    const pin = (text) => /CDXGEN_VERSION: (\S+)/.exec(text)?.[1];
    assert.ok(pin(security));
    assert.equal(pin(job), pin(security));
  });
});
