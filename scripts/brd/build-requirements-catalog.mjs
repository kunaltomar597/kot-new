#!/usr/bin/env node
// Builds docs/brd/requirements.json and docs/brd/requirements.md from the BRD text extraction
// (docs/brd/brd-v1.0.txt). Run with `pnpm brd:catalog` whenever the BRD text is replaced.
//
// The PDF (docs/brd/Restaurant_Platform_BRD_v1.0.pdf) is the authoritative source. The text file
// is a plain extraction used so Claude and scripts can search requirements quickly.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const brdDir = join(root, 'docs', 'brd');
const text = readFileSync(join(brdDir, 'brd-v1.0.txt'), 'utf8');

const REQ_START = /^((?:[A-Z]{2,4})-\d{3}|NFR-[A-Z]\d{2}) \(([MSC])\)\s?(.*)$/;
// Sub-section headings start with a capital letter ("6.4 Tables, sections and sessions (TBL)"),
// which keeps values such as "2.5 s on a mid-range phone" from being read as headings.
const SECTION = /^((?:[1-9]|1\d|2[01])\.\d{1,2}) ([A-Z].*)$/;
// Top-level headings are matched against the BRD's table of contents, so numbered steps inside
// a requirement ("3. It verifies the archive...") are not mistaken for headings.
const TOP_TITLES = new Set([
  'Executive summary',
  'Business objectives and success metrics',
  'Scope',
  'Stakeholders and user roles',
  'Solution overview',
  'Functional requirements',
  'Non-functional requirements',
  'Security requirements',
  'Data requirements',
  'Technical architecture and recommended stack',
  'Hardware and site requirements',
  'Compliance and regulatory requirements',
  'Assumptions',
  'Constraints',
  'Dependencies',
  'Risks and mitigations',
  'Release plan',
  'Testing and acceptance',
  'Business Owner responsibilities',
  'Open items',
  'Glossary',
]);
const TOP_SECTION = /^(\d{1,2})\. (.+)$/;
const NOISE = [/^=== PAGE \d+ ===$/, /^Hardware$/, /^Firmware$/, /^Appendix [A-D]:/];

// The performance table (§7.1) has no priorities in the text layout; all are Must.
const PERFORMANCE = [
  ['NFR-P01', 'Approved/sent order → visible on KDS ≤ 1 s (95th percentile).'],
  ['NFR-P02', 'KOT printed after sending ≤ 3 s (95th percentile).'],
  ['NFR-P03', 'Kitchen "Ready" / service request → pager vibrates ≤ 2 s (95th percentile).'],
  ['NFR-P04', 'Availability change → all in-restaurant devices ≤ 2 s (95th percentile).'],
  ['NFR-P05', 'Availability or menu change → QR menu (online) ≤ 30 s (95th percentile).'],
  ['NFR-P06', 'QR order submitted → received by local server (online) ≤ 5 s (95th percentile).'],
  ['NFR-P07', 'UI response to a tap (visual feedback) ≤ 100 ms; screen transitions ≤ 300 ms.'],
  ['NFR-P08', 'Bill generation and print ≤ 3 s (95th percentile).'],
  ['NFR-P09', 'Recommendations returned ≤ 200 ms (95th percentile).'],
  ['NFR-P10', 'Report over 12 months of data ≤ 5 s (95th percentile).'],
  ['NFR-P11', 'Client reconnection after server restart ≤ 30 s, with full resynchronisation.'],
  ['NFR-P12', 'QR menu first view (mid-range Android, 4G) LCP ≤ 2.5 s.'],
];

const requirements = [];
let current = null;
let section = '';

function flush() {
  if (!current) return;
  current.text = current.lines
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:])/g, '$1')
    .trim();
  delete current.lines;
  requirements.push(current);
  current = null;
}

for (const raw of text.split('\n')) {
  const line = raw.trim();
  if (line === '' || NOISE.some((pattern) => pattern.test(line))) continue;

  const start = REQ_START.exec(line);
  if (start) {
    flush();
    const [, id, priority, rest] = start;
    current = { id, area: id.split('-')[0], priority, section, lines: [rest] };
    continue;
  }
  const heading = SECTION.exec(line);
  if (heading && heading[2].length < 90) {
    flush();
    section = `${heading[1]} ${heading[2]}`;
    continue;
  }
  const top = TOP_SECTION.exec(line);
  if (top && TOP_TITLES.has(top[2].replace(/ \(India\)$/, ''))) {
    flush();
    section = `${top[1]}. ${top[2]}`;
    continue;
  }
  if (current) current.lines.push(line);
}
flush();

for (const [id, requirementText] of PERFORMANCE) {
  requirements.push({
    id,
    area: 'NFR',
    priority: 'M',
    section: '7.1 Performance',
    text: requirementText,
  });
}

const seen = new Set();
for (const requirement of requirements) {
  if (seen.has(requirement.id)) throw new Error(`Duplicate requirement id ${requirement.id}`);
  seen.add(requirement.id);
}

const byArea = new Map();
for (const requirement of requirements) {
  if (!byArea.has(requirement.area)) byArea.set(requirement.area, []);
  byArea.get(requirement.area).push(requirement);
}

const counts = { M: 0, S: 0, C: 0 };
for (const requirement of requirements) counts[requirement.priority] += 1;

writeFileSync(
  join(brdDir, 'requirements.json'),
  `${JSON.stringify({ source: 'BRD v1.0 (25 Sep 2026)', generatedBy: 'scripts/brd/build-requirements-catalog.mjs', counts, requirements }, null, 2)}\n`,
);

const md = [
  '# BRD v1.0 requirements catalogue',
  '',
  'Generated by `pnpm brd:catalog` from `docs/brd/brd-v1.0.txt`. Do not edit by hand.',
  'The PDF in this folder is authoritative; this file exists so requirements are easy to search.',
  'Text is a plain extraction: bullet structure is flattened and tables are not reproduced.',
  '',
  `Totals: ${requirements.length} requirements (${counts.M} Must, ${counts.S} Should, ${counts.C} Could).`,
  '',
];
for (const [area, list] of byArea) {
  md.push(`## ${area}`, '');
  let lastSection = '';
  for (const requirement of list) {
    if (requirement.section !== lastSection) {
      md.push(`Section: ${requirement.section}`, '');
      lastSection = requirement.section;
    }
    md.push(`- **${requirement.id}** (${requirement.priority}) ${requirement.text}`);
  }
  md.push('');
}
writeFileSync(join(brdDir, 'requirements.md'), md.join('\n'));

process.stdout.write(
  `Wrote ${requirements.length} requirements (${counts.M} M, ${counts.S} S, ${counts.C} C) across ${byArea.size} areas.\n`,
);
