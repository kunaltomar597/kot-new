import type { RushResult } from './rush.js';
import type { LatencySummary } from './stats.js';

/** Milliseconds as the report shows them: whole ms below 10 s, else seconds with one decimal. */
export function ms(value: number | null): string {
  if (value === null) return '–';
  return value < 10_000 ? `${String(Math.round(value))} ms` : `${(value / 1_000).toFixed(1)} s`;
}

function row(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function latency(summary: LatencySummary): string[] {
  return [
    String(summary.count),
    ms(summary.p50),
    ms(summary.p95),
    ms(summary.p99),
    ms(summary.max),
  ];
}

/** Where the run ran, for the record. */
export interface RunContext {
  readonly machine: string;
  readonly postgres: string;
  readonly command: string;
}

/** The run's results as Markdown, for `docs/build/performance.md` (P8-01a). */
export function renderReport(result: RushResult, context: RunContext): string {
  const { shape } = result;
  const lines: string[] = [];
  lines.push(
    `Run of ${result.startedAt.slice(0, 16).replace('T', ' ')} UTC on ${context.machine}, PostgreSQL ${context.postgres}.`,
    `Command: \`${context.command}\`.`,
    '',
    `- ${String(shape.tables)} tables, ${String(shape.dishes)} dishes, ${String(shape.stations)} stations with a kitchen screen and a ticket printer each, ${String(shape.billPrinters)} bill printers;`,
    `- ${String(result.devices)} live connections (${String(shape.tablets)} tablets, ${String(shape.waiters)} waiter phones, ${String(shape.stations)} kitchen screens, ${String(shape.posTerminals)} POS, ${String(shape.dashboards)} dashboards, the rest console screens with the alert centre) and ${String(result.pagers)} pagers;`,
    `- ${String(shape.ordersPerHour)} orders an hour for ${result.measuredMinutes.toFixed(1)} minutes after ${String(Math.round(shape.occupancy * shape.tables))} tables were seated, on ${shape.historyDays > 0 ? `${String(shape.historyDays)} days of history at ${String(shape.historyOrdersPerDay)} orders a day` : 'no history'}.`,
    '',
    row(['Target', 'What', 'Budget', 'Samples', 'p50', 'p95', 'p99', 'Max', 'Met']),
    row(['---', '---', '---:', '---:', '---:', '---:', '---:', '---:', '---']),
    ...result.targets.map((target) =>
      row([
        target.id,
        target.what,
        `${target.statistic} ≤ ${ms(target.budgetMs)}`,
        ...latency(target.summary),
        target.met ? 'yes' : '**no**',
      ]),
    ),
    '',
    ...Object.entries(result.breakdown).map(
      ([what, summary]) =>
        `${what}: p50 ${ms(summary.p50)}, p95 ${ms(summary.p95)}, max ${ms(summary.max)} (${String(summary.count)}).`,
    ),
    '',
    row(['Check', 'Result', 'Detail']),
    row(['---', '---', '---']),
    ...result.checks.map((check) =>
      row([check.name, check.ok ? 'pass' : '**fail**', check.detail]),
    ),
    '',
  );
  if (result.restart !== null) {
    lines.push(
      `The server was killed after the rush and was answering again ${ms(result.restart.downMs)} later; the pagers were back after ${ms(result.restart.pagers.p50)} (median) and ${ms(result.restart.pagers.max)} (the last).`,
      '',
    );
  }
  if (result.server !== null) {
    lines.push(
      `The server's process during the rush: ${result.server.cpuMeanPercent.toFixed(0)} % of one core on average, ${result.server.cpuMaxPercent.toFixed(0)} % at most; memory ${result.server.rssFirstMinuteMb.toFixed(0)} MB in the first minute, ${result.server.rssLastMinuteMb.toFixed(0)} MB in the last, ${result.server.rssMaxMb.toFixed(0)} MB at most (${String(result.server.samples)} samples, every 5 s).`,
    );
  }
  lines.push(
    `The load generator's own timers ran up to ${ms(result.harness.eventLoopP99Ms)} late (p99), ${ms(result.harness.eventLoopMaxMs)} at worst.`,
    '',
    row(['What happened', 'Times']),
    row(['---', '---:']),
    ...Object.entries(result.counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, times]) => row([name, String(times)])),
    '',
    'Requests during the rush, by operation:',
    '',
    row(['Operation', 'Calls', 'p50', 'p95', 'p99', 'Max']),
    row(['---', '---:', '---:', '---:', '---:', '---:']),
    ...Object.entries(result.http).map(([operation, summary]) =>
      row([`\`${operation}\``, ...latency(summary)]),
    ),
    '',
  );
  const errors = Object.entries(result.errors);
  lines.push(
    errors.length === 0
      ? 'No request failed.'
      : `Failed requests: ${errors.map(([key, times]) => `${key} ×${String(times)}`).join(', ')}.`,
  );
  return `${lines.join('\n')}\n`;
}
