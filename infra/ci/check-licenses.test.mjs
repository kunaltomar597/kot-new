// Run with `pnpm ci:test` (node:test; infra/ci is not a workspace package).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findViolations, satisfies } from './check-licenses.mjs';

const policy = {
  allowed: ['MIT', 'Apache-2.0', 'ISC'],
  blocked: ['^AGPL', '^GPL', '^SSPL'],
  exceptions: { 'reviewed-lib': { reason: 'Dual licensed commercially; licence bought 2026-09.' } },
};
const pkg = (name) => ({ name, versions: ['1.0.0'] });
const allowed = (id) => policy.allowed.includes(id);

describe('[NFR-M07] licence policy', () => {
  it('evaluates SPDX expressions', () => {
    assert.equal(satisfies('MIT', allowed), true);
    assert.equal(satisfies('(MIT OR GPL-3.0-only)', allowed), true);
    assert.equal(satisfies('MIT AND GPL-3.0-only', allowed), false);
    assert.equal(satisfies('(MIT AND ISC) OR SSPL-1.0', allowed), true);
    assert.equal(satisfies('GPL-2.0-only WITH Classpath-exception-2.0', allowed), false);
  });

  it('passes allowed licences', () => {
    assert.deepEqual(
      findViolations({ MIT: [pkg('a')], '(MIT OR Apache-2.0)': [pkg('b')] }, policy),
      [],
    );
  });

  it('fails GPL, AGPL and SSPL even with an exception', () => {
    const violations = findViolations(
      {
        'GPL-3.0-only': [pkg('gpl')],
        'AGPL-3.0-or-later': [pkg('agpl')],
        'SSPL-1.0': [pkg('reviewed-lib')],
      },
      policy,
    );
    assert.equal(violations.length, 3);
    assert.ok(violations.every((line) => line.includes('blocked licence')));
  });

  it('fails unknown licences unless a reviewed exception exists', () => {
    const violations = findViolations(
      { Unknown: [pkg('mystery')], 'LGPL-3.0-only': [pkg('reviewed-lib')] },
      policy,
    );
    assert.deepEqual(violations, ['mystery@1.0.0 (Unknown): licence not on the allow-list']);
  });
});
