// Run with `pnpm ci:test` (node:test; infra/ci is not a workspace package).
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CHECKLISTS,
  checkChecklist,
  checkChecklists,
  parseChecklist,
  tally,
  threatIds,
} from './check-checklists.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const list = { file: 'sample.md', prefix: 'SAMPLE', name: 'A sample' };

const repo = {
  exists: (path) => path === 'apps/server/src/thing.ts',
  workPackages: new Map([
    ['P8-04', ' '],
    ['P1-01a', 'x'],
  ]),
  manualTasks: new Set([33]),
  threats: new Set(['PC-E2']),
};

const check = (rows) =>
  checkChecklist(
    'sample.md',
    ['| ID | C | S | E | N |', '| - | - | - | - | - |', ...rows].join('\n'),
    list,
    repo,
  );

describe('security checklists [SEC-010, SEC-011]', () => {
  it('[SEC-010] reads the control rows and counts them by status', () => {
    const { problems, controls } = check([
      '| SAMPLE-1 | Logs hold no secrets | Met | `apps/server/src/thing.ts`, `PC-E2` | |',
      '| SAMPLE-2 | No browser | N/A | | The pager has no browser at all. |',
      '| SAMPLE-3 | Root detection | Finding | | Plan: manual task 33 by 2026-10-31. |',
    ]);
    assert.deepEqual(problems, []);
    assert.deepEqual(tally(controls), { Met: 1, 'N/A': 1, Finding: 1 });
  });

  it('[SEC-010] refuses evidence that does not exist or is not a path or threat', () => {
    const { problems } = check([
      '| SAMPLE-1 | A | Met | `apps/server/src/gone.ts` | |',
      '| SAMPLE-2 | B | Met | `PC-E9` | |',
      '| SAMPLE-3 | C | Met | `some words` | |',
    ]);
    assert.equal(problems.length, 3);
    assert.match(problems[0], /does not exist/);
    assert.match(problems[1], /in no threat model/);
    assert.match(problems[2], /neither a repository path nor a threat id/);
  });

  it('[SEC-011] refuses a control met without evidence or N/A without a reason', () => {
    const { problems } = check(['| SAMPLE-1 | A | Met | | |', '| SAMPLE-2 | B | N/A | | no |']);
    assert.match(problems.join('\n'), /met without evidence/);
    assert.match(problems.join('\n'), /without a reason/);
  });

  it('[SEC-011] needs a dated plan in an open work package or an existing manual task', () => {
    const { problems } = check([
      '| SAMPLE-1 | A | Finding | | Nothing planned. |',
      '| SAMPLE-2 | B | Finding | | Plan: P1-01a by 2026-10-31. |',
      '| SAMPLE-3 | C | Finding | | Plan: P9-99 by 2026-10-31. |',
      '| SAMPLE-4 | D | Finding | | Plan: manual task 99 by 2026-10-31. |',
      '| SAMPLE-5 | E | Finding | | Plan: P8-04 by 2026-02-31. |',
      '| SAMPLE-6 | F | Finding | | Plan: P8-04 by 2026-12-01. |',
    ]);
    assert.equal(problems.length, 5);
    assert.match(problems[0], /needs "Plan/);
    assert.match(problems[1], /is done/);
    assert.match(problems[2], /no work package/);
    assert.match(problems[3], /no manual task 99/);
    assert.match(problems[4], /not a date/);
  });

  it('[SEC-010] refuses an unknown status, a short row and a repeated id', () => {
    const { problems } = check([
      '| SAMPLE-1 | A | Maybe | `PC-E2` |',
      '| SAMPLE-1 | A | Met | `PC-E2` | |',
    ]);
    assert.match(problems.join('\n'), /is none of/);
    assert.match(problems.join('\n'), /five cells/);
    assert.match(problems.join('\n'), /listed twice/);
  });

  it('[SEC-010] finds threat ids at either heading level', () => {
    assert.deepEqual(
      [...threatIds(['#### PC-E2 A\n\n### MOBILE-S1 B\n\ntext PC-D1'])],
      ['PC-E2', 'MOBILE-S1'],
    );
  });

  it('[SEC-010] ignores rows of other tables', () => {
    assert.equal(parseChecklist('| a | b |\n| ASVS-1 | x | Met | y | z |', 'MASVS').length, 0);
  });

  it('[SEC-010] the four checklists of the repository are sound', () => {
    const { problems, results } = checkChecklists(root);
    assert.deepEqual(problems, []);
    assert.equal(results.length, CHECKLISTS.length);
  });
});
