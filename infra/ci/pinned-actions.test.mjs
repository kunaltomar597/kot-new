// Run with `pnpm ci:test` (node:test; infra/ci is not a workspace package).
//
// A tag or branch of a GitHub Action can be moved to other code by whoever controls its
// repository, and that code runs in CI with the job's token and secrets. Every Action is pinned to
// a full commit, with the version it is in a comment for Dependabot and for people (threat model
// "The update pipeline", UPDATE-T1).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const github = new URL('../../.github/', import.meta.url);
const folder = new URL('workflows/', github);
const workflows = Object.fromEntries(
  readdirSync(folder)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => [file, readFileSync(new URL(file, folder), 'utf8')]),
);

/** `owner/repo[/path]@<40 hex> # vX.Y.Z`: a commit, and the release it is. */
const PINNED = /^([\w.-]+\/[\w.-]+(?:\/[\w./-]+)?)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)$/;

/** Every `uses:` of a workflow: its line number and what it names, comment included. */
function usesOf(text) {
  return text.split('\n').flatMap((line, index) => {
    const match = /^\s*(?:-\s+)?uses:\s*(.+?)\s*$/.exec(line);
    if (match === null) return [];
    const value = match[1].replace(/^(['"])(.*)\1(\s+#.*)?$/, '$2$3');
    return [{ line: index + 1, value }];
  });
}

/** Why a `uses:` is not pinned, or null: actions in this repository and image digests are. */
function pinProblem(value) {
  if (value.startsWith('./')) return null;
  if (value.startsWith('docker://')) {
    return /@sha256:[0-9a-f]{64}$/.test(value) ? null : 'an image by tag, not by digest';
  }
  if (PINNED.test(value)) return null;
  const ref = /@([^\s#]+)/.exec(value)?.[1];
  if (ref === undefined) return 'no version at all';
  if (/^[0-9a-f]{40}$/.test(ref)) return 'a commit without the version it is in a comment';
  return `"${ref}", which its owner can move to other code`;
}

describe('[SEC-013] the GitHub Actions CI runs', () => {
  it('pins every Action in every workflow to a full commit, with the version it is', () => {
    const problems = Object.entries(workflows).flatMap(([file, text]) =>
      usesOf(text).flatMap(({ line, value }) => {
        const problem = pinProblem(value);
        return problem === null ? [] : [`${file}:${String(line)} ${value}: ${problem}`];
      }),
    );
    assert.deepEqual(problems, []);
    assert.ok(Object.values(workflows).flatMap(usesOf).length > 20);
  });

  it('runs each Action at one commit, in every workflow', () => {
    const seen = new Map();
    for (const text of Object.values(workflows)) {
      for (const { value } of usesOf(text)) {
        const match = PINNED.exec(value);
        if (match === null) continue;
        const [, action, commit, version] = match;
        const repository = action.split('/').slice(0, 2).join('/');
        const pin = `${commit} ${version}`;
        assert.equal(seen.get(repository) ?? pin, pin, repository);
        seen.set(repository, pin);
      }
    }
  });

  it('tells a pin from a tag, a branch or a short commit', () => {
    const commit = '3d3c42e5aac5ba805825da76410c181273ba90b1';
    assert.equal(pinProblem(`actions/checkout@${commit} # v7.0.1`), null);
    assert.equal(pinProblem(`github/codeql-action/init@${commit} # v4.38.2`), null);
    assert.equal(pinProblem('./.github/actions/setup'), null);
    assert.equal(pinProblem(`docker://alpine@sha256:${'a'.repeat(64)}`), null);
    assert.match(pinProblem('actions/checkout@v7'), /"v7", which its owner can move/);
    assert.match(pinProblem('actions/checkout@main'), /"main"/);
    assert.match(pinProblem('actions/checkout@3d3c42e # v7.0.1'), /"3d3c42e"/);
    assert.match(pinProblem(`actions/checkout@${commit}`), /without the version/);
    assert.match(pinProblem('actions/checkout'), /no version/);
    assert.match(pinProblem('docker://alpine:3'), /by tag/);
    assert.deepEqual(usesOf(`steps:\n  - uses: 'actions/checkout@v7'\n    with:\n`), [
      { line: 2, value: 'actions/checkout@v7' },
    ]);
  });

  it('has Dependabot propose new pins, after the same wait as for packages', () => {
    const dependabot = readFileSync(new URL('dependabot.yml', github), 'utf8');
    const actions = dependabot.split(/\n(?=\s+- package-ecosystem:)/).find((block) => {
      return /package-ecosystem:\s*github-actions/.test(block);
    });
    assert.ok(actions !== undefined);
    assert.match(actions, /cooldown:\s*\n\s+default-days: \d+/);
  });
});
