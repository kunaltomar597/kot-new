#!/usr/bin/env node
// Threat models (SEC-000, P8-03b): checks the STRIDE threat models in docs/security/threat-models/
// and keeps the summary in their index current.
//
// Every component has its model. Each model has its scope, assets, entry points, trust boundaries,
// data flows and the six STRIDE categories; each threat says how it is mitigated, in which code and
// which tests, its residual risk and its status. The checks keep that evidence true as the code
// changes: every file named exists, every symbol named is in its file, every test title quoted is
// in its test file, and a threat left open has a dated plan in a work package that is still open,
// or in a manual task.
//
// Usage:
//   pnpm security:threats           checks; fails if the index's summary is out of date
//   pnpm security:threats --write   also rewrites the summary
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

/** The components BRD SEC-000 and P8-03b name, each with its file and the prefix of its threats. */
export const COMPONENTS = [
  { file: 'local-server-and-lan.md', prefix: 'PC', name: 'The LAN and the local server' },
  { file: 'pager-channel.md', prefix: 'PAGER', name: 'The pager channel' },
  { file: 'qr-relay-and-site.md', prefix: 'RELAY', name: 'The QR relay and site' },
  { file: 'update-pipeline.md', prefix: 'UPDATE', name: 'The update pipeline' },
  { file: 'licence-mechanism.md', prefix: 'LICENCE', name: 'The licence mechanism' },
  { file: 'control-plane.md', prefix: 'CP', name: 'The Vendor Control Plane' },
  { file: 'desktop-shell.md', prefix: 'DESKTOP', name: 'The desktop shell' },
  { file: 'phones-and-tablets.md', prefix: 'MOBILE', name: 'The phones and tablets' },
];

export const STRIDE = [
  ['S', 'Spoofing'],
  ['T', 'Tampering'],
  ['R', 'Repudiation'],
  ['I', 'Information disclosure'],
  ['D', 'Denial of service'],
  ['E', 'Elevation of privilege'],
];

export const SECTIONS = [
  'Scope',
  'Assets',
  'Entry points',
  'Trust boundaries',
  'Data flows',
  'Threats',
];

const FIELDS = ['Mitigation', 'Code', 'Tests', 'Risk', 'Status'];
const LEVEL = '(Low|Medium|High)';
const STATUSES = ['Mitigated', 'Partly mitigated', 'Not mitigated', 'Accepted'];

/**
 * Residual risk from likelihood and impact after the mitigations as built: the OWASP Risk Rating
 * Methodology's matrix, with its "Note" counted as Low.
 */
const MATRIX = {
  Low: { Low: 'Low', Medium: 'Low', High: 'Medium' },
  Medium: { Low: 'Low', Medium: 'Medium', High: 'High' },
  High: { Low: 'Medium', Medium: 'High', High: 'Critical' },
};

export function ratingOf(likelihood, impact) {
  return MATRIX[likelihood]?.[impact];
}

/** A file in the repository, as written in a model: `apps/...`, `.github/...`, `MANUAL_TASKS.md`. */
const REPO_PATH =
  /^(?:(?:apps|packages|infra|docs|scripts|manual-tasks|firmware|\.github)\/[^\s<>*:]*|[A-Z][A-Z_]*\.md)$/;
const TEST_FILE = /\.(test|spec|e2e)\.(ts|tsx|js|mjs)$|\.Tests\.ps1$/;
const IDENTIFIER = /^[A-Za-z_$][\w$-]*$/;

const collapse = (text) => text.replace(/\s+/g, ' ').trim();

/** Splits a model into its headings, threats and their fields. */
export function parseModel(text) {
  const model = { title: undefined, sections: [], categories: [], threats: [] };
  let section;
  let category;
  let threat;
  let bullet;
  const endBullet = () => {
    if (threat !== undefined && bullet !== undefined) threat.bullets.push(collapse(bullet));
    bullet = undefined;
  };
  for (const [index, line] of text.split('\n').entries()) {
    const heading = /^(#{1,4}) (.+)$/.exec(line);
    if (heading !== null) {
      endBullet();
      const [, hashes, title] = heading;
      threat = undefined;
      if (hashes === '#') model.title = title;
      else if (hashes === '##') {
        section = title;
        category = undefined;
        model.sections.push(title);
      } else if (hashes === '###' && section === 'Threats') {
        category = { name: title, threats: [] };
        model.categories.push(category);
      } else if (hashes === '####' && category !== undefined) {
        const [id, ...words] = title.split(' ');
        threat = {
          id,
          title: words.join(' '),
          category: category.name,
          line: index + 1,
          description: '',
          bullets: [],
        };
        category.threats.push(threat);
        model.threats.push(threat);
      }
      continue;
    }
    if (threat === undefined) continue;
    if (line.startsWith('- ')) {
      endBullet();
      bullet = line.slice(2);
    } else if (bullet !== undefined && /^\s+\S/.test(line)) {
      bullet += ` ${line.trim()}`;
    } else if (line.trim() === '') {
      endBullet();
    } else if (bullet === undefined) {
      threat.description = collapse(`${threat.description} ${line}`);
    }
  }
  endBullet();
  for (const found of model.threats) {
    found.fields = {};
    for (const text of found.bullets) {
      const field = /^([A-Z][a-z]+): (.*)$/.exec(text);
      if (field !== null) found.fields[field[1]] = field[2];
      else (found.fields.unknown ??= []).push(text);
    }
  }
  return model;
}

/** The work packages in PROGRESS.md with their marks (`x`, `~`, ` `, `H`, `B`). */
export function workPackages(progress) {
  const marks = new Map();
  for (const match of progress.matchAll(/^\s*- \[([ x~HB])\] (P\d-[0-9A-Za-z]+)\b/gm)) {
    marks.set(match[2], match[1]);
  }
  return marks;
}

/** The tokens in backticks and in double quotes of a line, in order. */
function tokens(text) {
  return [...text.matchAll(/`([^`]+)`|"([^"]+)"/g)].map((match) =>
    match[1] !== undefined ? { code: match[1] } : { quoted: collapse(match[2]) },
  );
}

/**
 * Checks one model against the repository. `repo` gives `exists(path)`, `read(path)`,
 * `workPackages` and `manualTasks`; the result is a list of problems (empty when it is sound).
 */
export function checkModel(name, text, component, repo) {
  const problems = [];
  const problem = (message) => problems.push(`${name}: ${message}`);
  const model = parseModel(text);
  if (model.title === undefined || !model.title.startsWith('Threat model: ')) {
    problem('starts with "# Threat model: <component>"');
  }
  for (const section of SECTIONS) {
    if (!model.sections.includes(section)) problem(`has no "## ${section}" section`);
  }
  const names = model.categories.map((category) => category.name);
  if (names.join('|') !== STRIDE.map(([, label]) => label).join('|')) {
    problem(
      `lists the STRIDE categories ${STRIDE.map(([, l]) => l).join(', ')} under "## Threats"`,
    );
  }
  for (const category of model.categories) {
    if (category.threats.length === 0) problem(`has no threat under "${category.name}"`);
  }

  // Every repository file named anywhere in the model exists, and so does every relative link.
  for (const { code } of tokens(text)) {
    if (code !== undefined && REPO_PATH.test(code) && !repo.exists(code.replace(/\/$/, ''))) {
      problem(`names ${code}, which does not exist`);
    }
  }
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (target === '' || /^[a-z]+:/.test(target)) continue;
    const path = relative(repo.root, resolve(repo.root, dirname(name), target));
    if (!repo.exists(path)) problem(`links to ${match[1]}, which does not exist`);
  }

  const seen = new Set();
  for (const threat of model.threats) {
    const where = `${threat.id} (line ${String(threat.line)})`;
    const letter = STRIDE.find(([, label]) => label === threat.category)?.[0];
    const id = new RegExp(`^${component.prefix}-${letter ?? '?'}\\d+$`);
    if (!id.test(threat.id)) {
      problem(
        `${where}: the id is ${component.prefix}-${letter ?? '?'}<n> under ${threat.category}`,
      );
    }
    if (seen.has(threat.id)) problem(`${where}: the id is used twice`);
    seen.add(threat.id);
    if (threat.title.trim() === '') problem(`${where}: has no title`);
    if (threat.description === '') problem(`${where}: does not say what the attack is`);
    for (const field of FIELDS) {
      if (threat.fields[field] === undefined) problem(`${where}: has no "- ${field}:"`);
    }
    for (const text of threat.fields.unknown ?? []) {
      problem(`${where}: "- ${text.slice(0, 40)}..." is not one of ${FIELDS.join(', ')}`);
    }

    // Code: each file, then the symbols in it.
    let file;
    const code = threat.fields.Code ?? '';
    if (/^none\b/i.test(code) && !/\w+\W+\w+/.test(code.slice(4))) {
      problem(`${where}: "Code: none" says why`);
    }
    for (const token of tokens(code)) {
      if (token.code === undefined) continue;
      if (REPO_PATH.test(token.code)) {
        file = token.code.replace(/\/$/, '');
        continue;
      }
      if (file === undefined) {
        problem(`${where}: names \`${token.code}\` in Code before the file it is in`);
        continue;
      }
      if (!repo.exists(file) || repo.isDirectory(file)) continue;
      const source = repo.read(file);
      const symbol = token.code.replace(/\(\)$/, '');
      const parts = symbol.split('.').filter((part) => IDENTIFIER.test(part));
      const missing = (parts.length > 0 ? parts : [symbol]).filter(
        (part) => !source.includes(part),
      );
      if (missing.length > 0) problem(`${where}: \`${token.code}\` is not in ${file}`);
    }

    // Tests: each test file, then titles copied from it.
    const tests = threat.fields.Tests ?? '';
    if (/^none\b/i.test(tests)) {
      if (!/\w+\W+\w+/.test(tests.slice(4))) problem(`${where}: "Tests: none" says why`);
    } else {
      let testFile;
      let titles = 0;
      const closeFile = () => {
        if (testFile !== undefined && titles === 0) {
          problem(`${where}: quotes no test title from ${testFile}`);
        }
      };
      for (const token of tokens(tests)) {
        if (token.code !== undefined) {
          if (!REPO_PATH.test(token.code)) continue;
          closeFile();
          testFile = token.code;
          titles = 0;
          if (!TEST_FILE.test(testFile)) problem(`${where}: ${testFile} is not a test file`);
          continue;
        }
        titles += 1;
        if (testFile === undefined) {
          problem(`${where}: quotes "${token.quoted}" before its test file`);
        } else if (repo.exists(testFile) && !collapse(repo.read(testFile)).includes(token.quoted)) {
          problem(`${where}: no test titled "${token.quoted}" in ${testFile}`);
        }
      }
      closeFile();
      if (testFile === undefined)
        problem(`${where}: Tests names a test file, or says "none" and why`);
    }

    // Risk and status.
    const risk = new RegExp(
      `^likelihood ${LEVEL}, impact ${LEVEL}: (Low|Medium|High|Critical)\\.?$`,
    ).exec(threat.fields.Risk ?? '');
    const status = threat.fields.Status ?? '';
    const kind = STATUSES.find((candidate) => status.startsWith(candidate));
    threat.status = kind;
    if (threat.fields.Risk !== undefined && risk === null) {
      problem(`${where}: Risk reads "likelihood <Low|Medium|High>, impact <...>: <rating>."`);
    }
    if (risk !== null) {
      const expected = ratingOf(risk[1], risk[2]);
      threat.rating = risk[3];
      if (risk[3] !== expected) {
        problem(
          `${where}: likelihood ${risk[1]} and impact ${risk[2]} rate ${expected}, not ${risk[3]}`,
        );
      }
    }
    if (threat.fields.Status !== undefined && kind === undefined) {
      problem(`${where}: Status starts with one of ${STATUSES.join(', ')}`);
    }
    const plan = /Plan: (P\d-[0-9A-Za-z]+|manual task (\d+)) by (\d{4}-\d{2}-\d{2})\b/.exec(status);
    const accepted = /Accepted: \S/.test(status);
    threat.plan = plan === null ? undefined : { owner: plan[1], by: plan[3] };
    if (plan !== null) {
      const by = new Date(`${plan[3]}T00:00:00Z`);
      if (Number.isNaN(by.getTime()) || by.toISOString().slice(0, 10) !== plan[3]) {
        problem(`${where}: ${plan[3]} is not a date`);
      }
      if (plan[2] !== undefined) {
        if (!repo.manualTasks.has(Number(plan[2]))) {
          problem(`${where}: there is no manual task ${plan[2]} in manual-tasks/`);
        }
      } else {
        const mark = repo.workPackages.get(plan[1]);
        if (mark === undefined)
          problem(`${where}: there is no work package ${plan[1]} in PROGRESS.md`);
        else if (mark === 'x') {
          problem(`${where}: ${plan[1]} is done; say what it did about this threat`);
        }
      }
    }
    if (kind === 'Mitigated' && (threat.rating === 'High' || threat.rating === 'Critical')) {
      problem(`${where}: a ${threat.rating} residual risk is not mitigated`);
    }
    if ((threat.rating === 'High' || threat.rating === 'Critical') && plan === null) {
      problem(`${where}: a ${threat.rating} residual risk needs "Plan: <work package> by <date>"`);
    }
    if ((kind === 'Partly mitigated' || kind === 'Not mitigated') && plan === null && !accepted) {
      problem(
        `${where}: ${kind.toLowerCase()} needs "Plan: <work package> by <date>" or "Accepted: <why>"`,
      );
    }
    if (kind === 'Accepted' && !accepted) problem(`${where}: "Accepted: <why>"`);
  }
  return { problems, model };
}

const SUMMARY_START = '<!-- threat-summary:start -->';
const SUMMARY_END = '<!-- threat-summary:end -->';

/** The generated part of the index: counts per component and every open threat with its plan. */
export function summary(results) {
  const count = (threats, test) => threats.filter(test).length;
  const lines = [
    SUMMARY_START,
    '',
    'Written by `pnpm security:threats --write` from the models; do not edit it by hand.',
    '',
    '| Component | Threats | Mitigated | Partly mitigated | Not mitigated | Accepted | Residual Medium | Residual High or Critical |',
    '| --- | --: | --: | --: | --: | --: | --: | --: |',
  ];
  const all = [];
  for (const { component, model } of results) {
    const threats = model.threats;
    all.push(...threats.map((threat) => ({ ...threat, component })));
    lines.push(
      `| [${component.name}](${component.file}) | ${String(threats.length)} | ${[
        count(threats, (t) => t.status === 'Mitigated'),
        count(threats, (t) => t.status === 'Partly mitigated'),
        count(threats, (t) => t.status === 'Not mitigated'),
        count(threats, (t) => t.status === 'Accepted'),
        count(threats, (t) => t.rating === 'Medium'),
        count(threats, (t) => t.rating === 'High' || t.rating === 'Critical'),
      ].join(' | ')} |`,
    );
  }
  lines.push(
    `| All | ${String(all.length)} | ${[
      count(all, (t) => t.status === 'Mitigated'),
      count(all, (t) => t.status === 'Partly mitigated'),
      count(all, (t) => t.status === 'Not mitigated'),
      count(all, (t) => t.status === 'Accepted'),
      count(all, (t) => t.rating === 'Medium'),
      count(all, (t) => t.rating === 'High' || t.rating === 'Critical'),
    ].join(' | ')} |`,
    '',
    'Open threats and their plans, by date:',
    '',
    '| Threat | Residual | Status | Plan | By |',
    '| --- | --- | --- | --- | --- |',
  );
  const open = all
    .filter((threat) => threat.plan !== undefined)
    .sort(
      (a, b) =>
        a.plan.by.localeCompare(b.plan.by) ||
        a.plan.owner.localeCompare(b.plan.owner) ||
        a.id.localeCompare(b.id, 'en', { numeric: true }),
    );
  for (const threat of open) {
    const anchor = `${threat.id} ${threat.title}`
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s/g, '-');
    lines.push(
      `| [${threat.id}](${threat.component.file}#${anchor}) ${threat.title} | ${threat.rating ?? '?'} | ${threat.status ?? '?'} | ${threat.plan.owner} | ${threat.plan.by} |`,
    );
  }
  lines.push('', SUMMARY_END);
  return lines.join('\n');
}

/** The repository as the checks see it. */
export function repository(root) {
  const cache = new Map();
  const progress = readFileSync(join(root, 'docs', 'build', 'PROGRESS.md'), 'utf8');
  const manualTasks = new Set(
    readdirSync(join(root, 'manual-tasks'))
      .map((file) => /^(\d+)-/.exec(file)?.[1])
      .filter((number) => number !== undefined)
      .map(Number),
  );
  return {
    root,
    exists: (path) => existsSync(join(root, path)),
    isDirectory: (path) => statSync(join(root, path)).isDirectory(),
    read: (path) => {
      if (!cache.has(path)) cache.set(path, readFileSync(join(root, path), 'utf8'));
      return cache.get(path);
    },
    workPackages: workPackages(progress),
    manualTasks,
  };
}

/** Checks every model and the index; with `write`, rewrites the index's summary first. */
export async function checkThreatModels(root, { write = false } = {}) {
  const repo = repository(root);
  const folder = join('docs', 'security', 'threat-models');
  const problems = [];
  const results = [];
  for (const component of COMPONENTS) {
    const name = join(folder, component.file);
    if (!repo.exists(name)) {
      problems.push(`${name}: missing (SEC-000 asks for a model of ${component.name})`);
      continue;
    }
    const checked = checkModel(name, repo.read(name), component, repo);
    problems.push(...checked.problems);
    results.push({ component, model: checked.model });
  }
  const index = join(folder, 'README.md');
  if (!repo.exists(index)) {
    problems.push(`${index}: missing`);
    return { problems, results };
  }
  const current = readFileSync(join(root, index), 'utf8');
  const start = current.indexOf(SUMMARY_START);
  const end = current.indexOf(SUMMARY_END);
  if (start < 0 || end < start) {
    problems.push(`${index}: has no ${SUMMARY_START} ... ${SUMMARY_END} block`);
    return { problems, results };
  }
  const options = (await prettier.resolveConfig(join(root, index))) ?? {};
  const expected = await prettier.format(
    `${current.slice(0, start)}${summary(results)}${current.slice(end + SUMMARY_END.length)}`,
    { ...options, parser: 'markdown' },
  );
  if (expected !== current) {
    if (write) writeFileSync(join(root, index), expected);
    else problems.push(`${index}: the summary is out of date; run pnpm security:threats --write`);
  }
  return { problems, results };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const { problems, results } = await checkThreatModels(root, {
    write: process.argv.includes('--write'),
  });
  const threats = results.flatMap(({ model }) => model.threats);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exit(1);
  }
  const open = threats.filter((threat) => threat.plan !== undefined).length;
  process.stdout.write(
    `Threat models: ${String(results.length)} components, ${String(threats.length)} threats, ${String(open)} with a plan.\n`,
  );
}
