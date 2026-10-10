import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headerScript, writeHeaderRules } from './credentials.js';
import { forZap } from './openapi.js';
import { automationPlan } from './plan.js';
import { alertsOf } from './report.js';
import type { RunningTarget } from './targets/common.js';
import { type Judgement, judge, type TriageEntry } from './triage.js';
import { runZap, zapFolder, type ZapRunner } from './zap.js';

/** Where a run's plans and reports go: `RP_DAST_REPORTS`, or `infra/dast/reports`. */
export function reportsFolder(env: NodeJS.ProcessEnv = process.env): string {
  return env.RP_DAST_REPORTS ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'reports');
}

/** The triaged findings (`src/triage.json`). */
export function triageEntries(): TriageEntry[] {
  const file = join(dirname(fileURLToPath(import.meta.url)), 'triage.json');
  return (JSON.parse(readFileSync(file, 'utf8')) as { findings: TriageEntry[] }).findings;
}

/** How often the run renews the scan's credentials while ZAP works. */
const KEEP_FRESH_MS = 30_000;

/**
 * Scans one running surface: writes the plan, the request script and the credentials into the
 * surface's folder, runs ZAP while keeping the credentials fresh, and judges what it found.
 */
export async function scanTarget(
  running: RunningTarget,
  runner: ZapRunner,
  reports: string,
  entries: readonly TriageEntry[],
): Promise<Judgement> {
  const { target } = running;
  // Absolute: ZAP runs in a folder of its own.
  const folder = join(resolve(reports), target.name);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  const seen = zapFolder(runner, folder);
  if (target.openApi !== undefined && running.openApiSource !== undefined) {
    const document: unknown = JSON.parse(readFileSync(running.openApiSource, 'utf8'));
    writeFileSync(join(folder, target.openApi.file), JSON.stringify(forZap(document)));
  }
  writeFileSync(join(folder, 'headers.js'), headerScript(seen));
  writeHeaderRules(folder, running.headerRules());
  writeFileSync(join(folder, 'plan.yaml'), JSON.stringify(automationPlan(target, seen), null, 2));

  let renewing = Promise.resolve();
  const timer = setInterval(() => {
    renewing = renewing
      .then(async () => {
        if (await running.keepFresh()) writeHeaderRules(folder, running.headerRules());
      })
      .catch((error: unknown) => {
        // The scan goes on unauthenticated; the report shows the 401s.
        // eslint-disable-next-line no-console -- the run's own log, read with ZAP's.
        console.warn(`${target.name}: could not renew the credentials: ${String(error)}`);
      });
  }, KEEP_FRESH_MS);
  let code: number;
  try {
    // ZAP's start, the import, the spider and the passive scan come on top of the active scan.
    code = await runZap(runner, folder, 'plan.yaml', (target.activeScanMinutes + 15) * 60_000);
  } finally {
    clearInterval(timer);
    await renewing;
  }
  const reportFile = join(folder, `${target.name}.json`);
  if (code !== 0 || !existsSync(reportFile)) {
    const log = existsSync(join(folder, 'zap.log'))
      ? readFileSync(join(folder, 'zap.log'), 'utf8').split('\n').slice(-40).join('\n')
      : '';
    throw new Error(`ZAP's plan for ${target.name} failed (exit ${String(code)}):\n${log}`);
  }
  const alerts = alertsOf(JSON.parse(readFileSync(reportFile, 'utf8')), target.baseUrl);
  return judge(target.name, alerts, entries);
}
