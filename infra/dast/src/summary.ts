import type { TargetName } from './plan.js';
import { RISKS, type ZapAlert } from './report.js';
import type { Judgement, TriageEntry } from './triage.js';

const OPEN_WHY = {
  untriaged: 'not triaged',
  'high-accepted': 'a High cannot be accepted',
  'outside-triaged-urls': 'seen outside the triaged URLs',
} as const;

function places(alert: ZapAlert): string {
  const shown = alert.instances.slice(0, 3).join(', ');
  const more = alert.instances.length - 3;
  return more > 0 ? `${shown} and ${String(more)} more` : shown;
}

function counts(judgement: Judgement): Record<string, number> {
  const all = [
    ...judgement.open.map((open) => open.alert),
    ...judgement.triaged.map((triaged) => triaged.alert),
    ...judgement.informational,
  ];
  return Object.fromEntries(
    RISKS.map((risk) => [risk, all.filter((alert) => alert.risk === risk).length]),
  );
}

/**
 * The run's results in Markdown (`reports/summary.md`, printed at the end): per surface, the
 * findings by risk, those still open, those triaged and why; and the triage entries no finding
 * needed this time.
 */
export function summary(
  judgements: readonly Judgement[],
  entries: readonly TriageEntry[],
  scanned: readonly TargetName[],
): string {
  const lines = [
    '# DAST results',
    '',
    '| Surface | High | Medium | Low | Informational | Open |',
    '| ------- | ---- | ------ | --- | ------------- | ---- |',
  ];
  for (const judgement of judgements) {
    const count = counts(judgement);
    lines.push(
      `| ${judgement.target} | ${String(count.High)} | ${String(count.Medium)} | ${String(count.Low)} | ${String(count.Informational)} | ${String(judgement.open.length)} |`,
    );
  }
  for (const judgement of judgements) {
    lines.push('', `## ${judgement.target}`, '');
    if (judgement.open.length > 0) {
      lines.push('Open:', '');
      for (const { alert, why } of judgement.open) {
        lines.push(
          `- **${alert.risk}** ${alert.alertRef} ${alert.name} (${OPEN_WHY[why]}): ${places(alert)}`,
        );
      }
      lines.push('');
    }
    if (judgement.triaged.length > 0) {
      lines.push('Triaged:', '');
      for (const { alert, entry } of judgement.triaged) {
        lines.push(`- ${alert.risk} ${alert.alertRef} ${alert.name}: ${entry.decision}.`);
      }
      lines.push('');
    }
    if (judgement.informational.length > 0) {
      lines.push(
        `Informational: ${judgement.informational.map((alert) => `${alert.alertRef} ${alert.name}`).join('; ')}.`,
      );
    }
  }
  const used = new Set(judgements.flatMap((judgement) => judgement.used));
  const unused = entries.filter(
    (entry) => !used.has(entry) && (entry.target === '*' || scanned.includes(entry.target)),
  );
  if (unused.length > 0) {
    lines.push(
      '',
      '## Triage entries no finding needed',
      '',
      'Fixed since, or not reached this time; remove an entry once its fix is in.',
      '',
      ...unused.map((entry) => `- ${entry.target} ${entry.alert} ${entry.name}`),
    );
  }
  return `${lines.join('\n')}\n`;
}
