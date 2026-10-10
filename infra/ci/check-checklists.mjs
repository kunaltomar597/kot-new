#!/usr/bin/env node
// Standards checklists (BRD §8.1, SEC-010, SEC-011, P8-03d2b2d): checks the four checklists in
// docs/security/checklists/ (OWASP ASVS L2 with the Top 10s, MASVS, ETSI EN 303 645, CIS).
//
// Every control is one table row: `| ID | Control | Status | Evidence | Notes |`. A control is
// Met (with evidence), N/A (with the reason in Notes) or a Finding (with "Plan: <work package or
// manual task> by <date>"). Evidence is repository files and folders, or threat ids from the threat
// models, in backticks. The checks keep the evidence true as the code changes: every file named
// exists and every threat named is in a model.
//
// Usage: pnpm security:checklists
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workPackages } from './check-threat-models.mjs';

/** The checklists BRD §8.1 names, each with its file and the prefix of its control ids. */
export const CHECKLISTS = [
  { file: 'asvs.md', prefix: 'ASVS', name: 'OWASP ASVS Level 2, Top 10 and API Top 10' },
  { file: 'masvs.md', prefix: 'MASVS', name: 'OWASP MASVS-L1 with resilience' },
  { file: 'etsi-en-303-645.md', prefix: 'ETSI', name: 'ETSI EN 303 645' },
  { file: 'cis-windows.md', prefix: 'CIS', name: 'CIS for the Windows host' },
];

export const STATUSES = ['Met', 'N/A', 'Finding'];

const REPO_PATH =
  /^(?:(?:apps|packages|infra|docs|scripts|manual-tasks|firmware|\.github)\/[^\s<>*:]*|[A-Z][A-Z_]*\.md)$/;
const THREAT_ID = /^(?:PC|PAGER|RELAY|UPDATE|LICENCE|CP|DESKTOP|MOBILE)-[STRIDE]\d+$/;
const PLAN = /Plan: (?:manual task (\d+)|(P\d-[0-9A-Za-z]+)) by (\d{4}-\d{2}-\d{2})/;

const collapse = (text) => text.replace(/\s+/g, ' ').trim();

/** The control rows of a checklist: `| PREFIX-n | control | status | evidence | notes |`. */
export function parseChecklist(text, prefix) {
  const controls = [];
  const rows = text.split('\n').filter((line) => line.startsWith('|'));
  for (const line of rows) {
    const cells = line
      .slice(1, line.endsWith('|') ? -1 : undefined)
      .split(/(?<!\\)\|/)
      .map((cell) => collapse(cell.replace(/\\\|/g, '|')));
    if (!new RegExp(`^${prefix}-[\\w.]+$`).test(cells[0] ?? '')) continue;
    controls.push({
      id: cells[0],
      control: cells[1] ?? '',
      status: cells[2] ?? '',
      evidence: cells[3] ?? '',
      notes: cells[4] ?? '',
      cells: cells.length,
    });
  }
  return controls;
}

/** The threat ids of the models, as `PC-E2`. */
export function threatIds(models) {
  const ids = new Set();
  for (const text of models) {
    for (const match of text.matchAll(/^#{3,4}\s+([A-Z]+-[STRIDE]\d+)\b/gm)) ids.add(match[1]);
  }
  return ids;
}

/**
 * Checks one checklist. `repo` gives `exists(path)`, `workPackages`, `manualTasks` and `threats`;
 * the result is a list of problems (empty when it is sound).
 */
export function checkChecklist(name, text, list, repo) {
  const problems = [];
  const controls = parseChecklist(text, list.prefix);
  if (controls.length === 0) problems.push(`${name}: has no controls (${list.prefix}-n rows)`);
  const seen = new Set();
  for (const control of controls) {
    const where = `${name}: ${control.id}`;
    const problem = (message) => problems.push(`${where}: ${message}`);
    if (seen.has(control.id)) problem('is listed twice');
    seen.add(control.id);
    if (control.cells !== 5) problem('needs five cells: id, control, status, evidence, notes');
    if (control.control === '') problem('says nothing about the control');
    if (!STATUSES.includes(control.status)) {
      problem(`status "${control.status}" is none of ${STATUSES.join(', ')}`);
    }
    const tokens = [...control.evidence.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    for (const token of tokens) {
      if (THREAT_ID.test(token)) {
        if (!repo.threats.has(token)) problem(`threat ${token} is in no threat model`);
      } else if (REPO_PATH.test(token)) {
        if (!repo.exists(token)) problem(`evidence ${token} does not exist`);
      } else {
        problem(`evidence \`${token}\` is neither a repository path nor a threat id`);
      }
    }
    if (control.status === 'Met' && tokens.length === 0) {
      problem('is met without evidence (name a file, a folder or a threat in backticks)');
    }
    if (control.status === 'N/A' && control.notes.length < 12) {
      problem('is not applicable without a reason in Notes');
    }
    if (control.status === 'Finding') {
      const plan = PLAN.exec(control.notes);
      if (plan === null) {
        problem('a finding needs "Plan: <work package or manual task N> by <date>" in Notes');
      } else {
        const by = new Date(`${plan[3]}T00:00:00Z`);
        if (Number.isNaN(by.getTime()) || by.toISOString().slice(0, 10) !== plan[3]) {
          problem(`${plan[3]} is not a date`);
        }
        if (plan[1] !== undefined) {
          if (!repo.manualTasks.has(Number(plan[1]))) {
            problem(`there is no manual task ${plan[1]} in manual-tasks/`);
          }
        } else {
          const mark = repo.workPackages.get(plan[2]);
          if (mark === undefined) problem(`there is no work package ${plan[2]} in PROGRESS.md`);
          else if (mark === 'x') problem(`${plan[2]} is done; say what it did about this control`);
        }
      }
    }
  }
  return { problems, controls };
}

/** Counts by status, for the index and the report. */
export function tally(controls) {
  const counts = { Met: 0, 'N/A': 0, Finding: 0 };
  for (const control of controls) if (control.status in counts) counts[control.status] += 1;
  return counts;
}

/** The repository as the checks see it. */
export function repository(root) {
  const progress = readFileSync(join(root, 'docs', 'build', 'PROGRESS.md'), 'utf8');
  const folder = join(root, 'docs', 'security', 'threat-models');
  const models = readdirSync(folder)
    .filter((file) => file.endsWith('.md'))
    .map((file) => readFileSync(join(folder, file), 'utf8'));
  return {
    root,
    exists: (path) => existsSync(join(root, path)),
    workPackages: workPackages(progress),
    manualTasks: new Set(
      readdirSync(join(root, 'manual-tasks'))
        .map((file) => /^(\d+)-/.exec(file)?.[1])
        .filter((number) => number !== undefined)
        .map(Number),
    ),
    threats: threatIds(models),
  };
}

/** Checks every checklist. */
export function checkChecklists(root) {
  const repo = repository(root);
  const folder = join('docs', 'security', 'checklists');
  const problems = [];
  const results = [];
  for (const list of CHECKLISTS) {
    const name = join(folder, list.file);
    if (!repo.exists(name)) {
      problems.push(`${name}: missing (BRD §8.1 asks for the ${list.name} checklist)`);
      continue;
    }
    const checked = checkChecklist(name, readFileSync(join(root, name), 'utf8'), list, repo);
    problems.push(...checked.problems);
    results.push({ list, controls: checked.controls });
  }
  return { problems, results };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const { problems, results } = checkChecklists(root);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exit(1);
  }
  for (const { list, controls } of results) {
    const counts = tally(controls);
    process.stdout.write(
      `${list.name}: ${String(controls.length)} controls, ${String(counts.Met)} met, ${String(counts['N/A'])} not applicable, ${String(counts.Finding)} findings.\n`,
    );
  }
}
