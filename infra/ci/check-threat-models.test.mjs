// Run with `pnpm ci:test` (node:test; infra/ci is not a workspace package).
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  COMPONENTS,
  STRIDE,
  checkModel,
  checkThreatModels,
  parseModel,
  ratingOf,
  summary,
} from './check-threat-models.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const component = { file: 'sample.md', prefix: 'SAMPLE', name: 'A sample' };

/** A repository of a few files, for the checks to look things up in. */
function repo(files = {}) {
  const all = new Map(
    Object.entries({
      'apps/server/src/thing.ts': 'export function guard() {}\nexport class Thing { check() {} }',
      'apps/server/test/thing.test.ts': "it('refuses a stranger, and audits it', () => {});",
      ...files,
    }),
  );
  return {
    root: '/repo',
    exists: (path) => all.has(path),
    isDirectory: () => false,
    read: (path) => all.get(path),
    workPackages: new Map([
      ['P8-03b2', ' '],
      ['P1-01a', 'x'],
    ]),
    manualTasks: new Set([1, 23]),
  };
}

const THREAT = {
  description: 'Someone does something they should not.',
  Mitigation: 'the guard refuses them.',
  Code: '`apps/server/src/thing.ts` (`guard`, `Thing.check`)',
  Tests: '`apps/server/test/thing.test.ts` "refuses a stranger, and audits it"',
  Risk: 'likelihood Low, impact High: Medium.',
  Status: 'Mitigated.',
};

/** A model with one threat per STRIDE category; `change` alters the first threat. */
function sample(change = {}, { categories = STRIDE } = {}) {
  const lines = ['# Threat model: A sample', ''];
  for (const section of ['Scope', 'Assets', 'Entry points', 'Trust boundaries', 'Data flows']) {
    lines.push(`## ${section}`, '', '- Something.', '');
  }
  lines.push('## Threats', '');
  categories.forEach(([letter, label], index) => {
    const threat = index === 0 ? { ...THREAT, ...change } : THREAT;
    lines.push(`### ${label}`, '', `#### SAMPLE-${letter}1 A threat`, '');
    if (threat.description !== undefined) lines.push(threat.description, '');
    for (const field of ['Mitigation', 'Code', 'Tests', 'Risk', 'Status']) {
      if (threat[field] !== undefined) lines.push(`- ${field}: ${threat[field]}`);
    }
    lines.push('');
  });
  return lines.join('\n');
}

const problemsOf = (text, files) =>
  checkModel('docs/security/threat-models/sample.md', text, component, repo(files)).problems;

describe('[SEC-000] STRIDE threat models', () => {
  it('cover every component, and every model passes its checks', async () => {
    const { problems, results } = await checkThreatModels(root);
    assert.deepEqual(problems, []);
    assert.deepEqual(
      results.map(({ component: c }) => c.file),
      COMPONENTS.map((c) => c.file),
    );
    for (const { model } of results) {
      assert.deepEqual(
        model.categories.map((category) => category.name),
        STRIDE.map(([, label]) => label),
      );
      // Acceptance (P8-03b): no residual High or Critical without a dated plan.
      for (const threat of model.threats) {
        if (threat.rating === 'High' || threat.rating === 'Critical') assert.ok(threat.plan);
      }
    }
  });

  it('rates the residual risk with the OWASP matrix', () => {
    assert.equal(ratingOf('Low', 'Low'), 'Low');
    assert.equal(ratingOf('Medium', 'Low'), 'Low');
    assert.equal(ratingOf('Low', 'High'), 'Medium');
    assert.equal(ratingOf('Medium', 'Medium'), 'Medium');
    assert.equal(ratingOf('Medium', 'High'), 'High');
    assert.equal(ratingOf('High', 'Medium'), 'High');
    assert.equal(ratingOf('High', 'High'), 'Critical');
    assert.equal(ratingOf('Huge', 'High'), undefined);
  });

  it('reads a threat, its fields and a description written over several lines', () => {
    const model = parseModel(sample({ Mitigation: 'the guard\n  refuses them.' }));
    assert.equal(model.threats.length, 6);
    assert.equal(model.threats[0].id, 'SAMPLE-S1');
    assert.equal(model.threats[0].fields.Mitigation, 'the guard refuses them.');
    assert.equal(model.threats[0].description, 'Someone does something they should not.');
    assert.deepEqual(problemsOf(sample()), []);
  });

  it('refuses a model without its sections, categories, descriptions or fields', () => {
    const missing = problemsOf(
      sample({}, { categories: STRIDE.slice(0, 5) }).replace('## Scope', '## Range'),
    );
    assert.ok(missing.some((p) => p.includes('has no "## Scope" section')));
    assert.ok(missing.some((p) => p.includes('lists the STRIDE categories')));
    const bare = problemsOf(sample({ description: undefined, Tests: undefined }));
    assert.ok(bare.some((p) => p.includes('does not say what the attack is')));
    assert.ok(bare.some((p) => p.includes('has no "- Tests:"')));
    const wrongId = problemsOf(sample().replace('SAMPLE-S1', 'SAMPLE-T9'));
    assert.ok(wrongId.some((p) => p.includes('the id is SAMPLE-S<n> under Spoofing')));
  });

  it('checks the evidence: files, the symbols in them and the test titles', () => {
    const problems = problemsOf(
      sample({
        Code: '`apps/server/src/thing.ts` (`guard`, `Thing.forgotten`); `apps/server/src/gone.ts`',
        Tests:
          '`apps/server/test/thing.test.ts` "refuses a stranger", "lets everyone in"; `apps/server/src/thing.ts` "guard"',
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('names apps/server/src/gone.ts, which does not exist')),
    );
    assert.ok(
      problems.some((p) => p.includes('`Thing.forgotten` is not in apps/server/src/thing.ts')),
    );
    assert.ok(problems.some((p) => p.includes('no test titled "lets everyone in"')));
    assert.ok(problems.some((p) => p.includes('apps/server/src/thing.ts is not a test file')));
    assert.ok(!problems.some((p) => p.includes('"refuses a stranger"')));
    const none = problemsOf(sample({ Tests: 'none.' }));
    assert.ok(none.some((p) => p.includes('"Tests: none" says why')));
    assert.deepEqual(problemsOf(sample({ Tests: 'none, a person checks it on site.' })), []);
  });

  it('keeps ratings true and open threats planned', () => {
    const wrong = problemsOf(sample({ Risk: 'likelihood Medium, impact High: Medium.' }));
    assert.ok(wrong.some((p) => p.includes('rate High, not Medium')));
    const high = problemsOf(
      sample({ Risk: 'likelihood Medium, impact High: High.', Status: 'Mitigated.' }),
    );
    assert.ok(high.some((p) => p.includes('a High residual risk is not mitigated')));
    assert.ok(high.some((p) => p.includes('needs "Plan: <work package> by <date>"')));
    const open = problemsOf(sample({ Status: 'Partly mitigated.' }));
    assert.ok(open.some((p) => p.includes('partly mitigated needs')));
    assert.deepEqual(problemsOf(sample({ Status: 'Partly mitigated. Accepted: by design.' })), []);
    assert.deepEqual(
      problemsOf(
        sample({
          Risk: 'likelihood Medium, impact High: High.',
          Status: 'Not mitigated. Plan: P8-03b2 by 2026-10-13: fix it.',
        }),
      ),
      [],
    );
    assert.deepEqual(
      problemsOf(sample({ Status: 'Partly mitigated. Plan: manual task 23 by 2026-11-30.' })),
      [],
    );
  });

  it('refuses a plan in a work package that is done or unknown, or on no date', () => {
    const done = problemsOf(sample({ Status: 'Partly mitigated. Plan: P1-01a by 2026-10-13.' }));
    assert.ok(done.some((p) => p.includes('P1-01a is done; say what it did about this threat')));
    const unknown = problemsOf(sample({ Status: 'Partly mitigated. Plan: P9-99 by 2026-10-13.' }));
    assert.ok(unknown.some((p) => p.includes('there is no work package P9-99')));
    const task = problemsOf(
      sample({ Status: 'Partly mitigated. Plan: manual task 7 by 2026-10-13.' }),
    );
    assert.ok(task.some((p) => p.includes('there is no manual task 7')));
    const date = problemsOf(sample({ Status: 'Partly mitigated. Plan: P8-03b2 by 2026-02-30.' }));
    assert.ok(date.some((p) => p.includes('2026-02-30 is not a date')));
  });

  it('sums up every model, and lists the open threats by date', () => {
    const { model } = checkModel(
      'docs/security/threat-models/sample.md',
      sample({
        Risk: 'likelihood Medium, impact High: High.',
        Status: 'Not mitigated. Plan: P8-03b2 by 2026-10-13: fix it.',
      }),
      component,
      repo(),
    );
    const text = summary([{ component, model }]);
    assert.match(text, /\| \[A sample\]\(sample\.md\) \| 6 \| 5 \| 0 \| 1 \| 0 \| 5 \| 1 \|/);
    assert.match(
      text,
      /\| \[SAMPLE-S1\]\(sample\.md#sample-s1-a-threat\) A threat \| High \| Not mitigated \| P8-03b2 \| 2026-10-13 \|/,
    );
  });
});
