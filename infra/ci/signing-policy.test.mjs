// Run with `pnpm ci:test` (node:test; infra/ci is not a workspace package).
//
// The code-signing certificate signs an installer as the vendor's, and every restaurant PC runs
// an update signed with it as SYSTEM. These tests keep it to pushes to main (threat model "The
// update pipeline", UPDATE-E2): a pull request's build never sees it.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const folder = new URL('../../.github/workflows/', import.meta.url);
const workflows = Object.fromEntries(
  readdirSync(folder)
    .filter((file) => file.endsWith('.yml'))
    .map((file) => [file, readFileSync(new URL(file, folder), 'utf8')]),
);
const ci = workflows['ci.yml'] ?? '';
const lines = ci.split('\n');
const MAIN = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
const line = (pattern) => lines.find((candidate) => pattern.test(candidate)) ?? '';

describe('[SEC-013] [SEC-006] code signing in CI', () => {
  it('gives the certificate only to a push to main, in its environment', () => {
    const uses = lines.filter((candidate) => candidate.includes('secrets.WINDOWS_CERTIFICATE_'));
    assert.equal(uses.length, 4);
    for (const use of uses) assert.match(use, /env\.RP_UPDATE_PUBLISHER != '' && secrets\./);
    assert.ok(line(/^\s+RP_UPDATE_PUBLISHER:/).includes(`${MAIN} && vars.RP_UPDATE_PUBLISHER`));
    assert.ok(line(/^\s+environment:.*release-signing/).includes(MAIN));
  });

  it('[UPDATE-S2] pins the signer by its issuer too, on main only', () => {
    assert.ok(line(/^\s+RP_UPDATE_ISSUER:/).includes(`${MAIN} && vars.RP_UPDATE_ISSUER`));
  });

  it('builds everything else as unsigned test builds that take unsigned updates', () => {
    assert.ok(
      line(/^\s+RP_ALLOW_UNSIGNED_UPDATES:/).includes(
        "(github.event_name != 'push' || github.ref != 'refs/heads/main' || vars.RP_UPDATE_PUBLISHER == '') && '1'",
      ),
    );
  });

  it('uses the certificate in no other workflow, and runs no pull_request_target', () => {
    for (const [file, text] of Object.entries(workflows)) {
      if (file !== 'ci.yml') assert.doesNotMatch(text, /WINDOWS_CERTIFICATE_|WIN_CSC_/, file);
      assert.doesNotMatch(text, /pull_request_target/, file);
    }
  });
});
