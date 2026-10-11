import { type TargetName, TARGETS } from './plan.js';
import type { ZapAlert } from './report.js';

/**
 * A finding looked at by a person (or by Claude, as the build's owner), with what was decided:
 * `false-positive` (ZAP is wrong here, and why) or `accepted` (true, and why it stays). A High is
 * never accepted: it is fixed, or shown to be a false positive (P8-03 acceptance).
 */
export interface TriageEntry {
  /** A surface, or `*` for all four. */
  readonly target: TargetName | '*';
  /** ZAP's rule id (`10035`), or one kind of its alerts (`10055-4`). */
  readonly alert: string;
  /** ZAP's name for it, for people reading the file. */
  readonly name: string;
  readonly decision: (typeof DECISIONS)[number];
  readonly reason: string;
  /**
   * Only where these URLs match (a JavaScript regular expression on `METHOD url`): an instance
   * elsewhere is not covered and stays open.
   */
  readonly where?: string;
}

const DECISIONS = ['false-positive', 'accepted'] as const;

/** Why a finding stops the run. */
export type OpenReason = 'untriaged' | 'high-accepted' | 'outside-triaged-urls';

export interface Judgement {
  readonly target: TargetName;
  /** Findings that stop the run. */
  readonly open: readonly { readonly alert: ZapAlert; readonly why: OpenReason }[];
  readonly triaged: readonly { readonly alert: ZapAlert; readonly entry: TriageEntry }[];
  /** Informational alerts: listed, never judged. */
  readonly informational: readonly ZapAlert[];
  /** The entries that covered a finding this time. */
  readonly used: readonly TriageEntry[];
}

/** Problems with the triage file itself; empty when every entry is sound. */
export function triageProblems(entries: readonly TriageEntry[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const where = `entry ${String(index + 1)} (${entry.alert} ${entry.name})`;
    if (entry.target !== '*' && !(TARGETS as readonly string[]).includes(entry.target)) {
      problems.push(`${where}: unknown target ${entry.target}`);
    }
    if (!/^\d+(-\d+)?$/.test(entry.alert)) problems.push(`${where}: alert is not a ZAP rule id`);
    // The file is read as JSON: its values are whatever was typed.
    if (!(DECISIONS as readonly string[]).includes(entry.decision)) {
      problems.push(`${where}: decision must be false-positive or accepted`);
    }
    if (entry.reason.trim().length < 30) problems.push(`${where}: give the reason in full`);
    if (entry.where !== undefined) {
      try {
        new RegExp(entry.where);
      } catch {
        problems.push(`${where}: where is not a regular expression`);
      }
    }
    const key = `${entry.target} ${entry.alert} ${entry.where ?? ''}`;
    if (seen.has(key)) problems.push(`${where}: the same finding is triaged twice`);
    seen.add(key);
  });
  return problems;
}

function matches(entry: TriageEntry, target: TargetName, alert: ZapAlert): boolean {
  if (entry.target !== '*' && entry.target !== target) return false;
  return entry.alert.includes('-')
    ? entry.alert === alert.alertRef
    : entry.alert === alert.pluginId;
}

/**
 * Judges a surface's findings against the triage: a High stays open unless it is a false
 * positive; anything else needs entries covering every place it was seen.
 */
export function judge(
  target: TargetName,
  alerts: readonly ZapAlert[],
  entries: readonly TriageEntry[],
): Judgement {
  const open: { alert: ZapAlert; why: OpenReason }[] = [];
  const triaged: { alert: ZapAlert; entry: TriageEntry }[] = [];
  const informational: ZapAlert[] = [];
  const used = new Set<TriageEntry>();
  for (const alert of alerts) {
    if (alert.risk === 'Informational') {
      informational.push(alert);
      continue;
    }
    const candidates = entries.filter((entry) => matches(entry, target, alert));
    if (candidates.length === 0) {
      open.push({ alert, why: 'untriaged' });
      continue;
    }
    const covering = (instance: string) =>
      candidates.find(
        (entry) => entry.where === undefined || new RegExp(entry.where).test(instance),
      );
    const uncovered = alert.instances.filter((instance) => covering(instance) === undefined);
    if (uncovered.length > 0) {
      open.push({ alert: { ...alert, instances: uncovered }, why: 'outside-triaged-urls' });
      continue;
    }
    const by =
      alert.instances.length === 0 ? candidates.slice(0, 1) : alert.instances.map(covering);
    const decided = by.filter((entry): entry is TriageEntry => entry !== undefined);
    for (const entry of decided) used.add(entry);
    if (alert.risk === 'High' && decided.some((entry) => entry.decision === 'accepted')) {
      open.push({ alert, why: 'high-accepted' });
      continue;
    }
    const [entry] = decided;
    if (entry !== undefined) triaged.push({ alert, entry });
  }
  return { target, open, triaged, informational, used: [...used] };
}
