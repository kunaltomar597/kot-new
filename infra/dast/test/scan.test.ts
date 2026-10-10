import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TargetName } from '../src/plan.js';
import { reportsFolder, scanTarget, triageEntries } from '../src/scan.js';
import { summary } from '../src/summary.js';
import type { RunningTarget } from '../src/targets/common.js';
import { startControlPlane } from '../src/targets/control-plane.js';
import { startLocalServer } from '../src/targets/local-server.js';
import {
  type RelaySetup,
  relayTarget,
  startQrSite,
  startRelaySetup,
} from '../src/targets/relay.js';
import type { Judgement } from '../src/triage.js';
import { zapRunnerFrom } from '../src/zap.js';

/**
 * The DAST run (P8-03c1, SEC-017): each surface started as it runs for real and scanned by OWASP
 * ZAP. Runs with RP_DAST=1 and ZAP_PATH or ZAP_DOCKER_IMAGE (`pnpm security:dast`), after
 * `pnpm build`; RP_DAST_TARGETS=relay,qr-site scans only those. The summary is written to
 * reports/summary.md.
 */
const runner = zapRunnerFrom(process.env);
const chosen = (process.env.RP_DAST_TARGETS ?? '').split(',').filter((name) => name !== '');
const skip = (name: TargetName) =>
  process.env.RP_DAST !== '1' ||
  runner === undefined ||
  (chosen.length > 0 && !chosen.includes(name));
/** The longest scan (20 minutes of attack) with ZAP's start, import, spider and passive scan. */
const SCAN_TIMEOUT = 45 * 60_000;

describe('[SEC-017] DAST of the QR site, the relay, the Control Plane and the local server', () => {
  const reports = reportsFolder();
  const entries = triageEntries();
  const judgements: Judgement[] = [];
  let relay: RelaySetup | undefined;

  beforeAll(() => {
    mkdirSync(reports, { recursive: true });
  });

  afterAll(async () => {
    await relay?.stop();
    if (judgements.length === 0) return;
    const text = summary(
      judgements,
      entries,
      judgements.map((judgement) => judgement.target),
    );
    writeFileSync(join(reports, 'summary.md'), text);
    // eslint-disable-next-line no-console -- the run's results, also in reports/summary.md.
    console.log(text);
  });

  async function scanned(start: () => Promise<RunningTarget>): Promise<string[]> {
    if (runner === undefined) throw new Error('No ZAP');
    const running = await start();
    try {
      const judgement = await scanTarget(running, runner, reports, entries);
      judgements.push(judgement);
      return judgement.open.map(
        ({ alert, why }) => `${alert.risk} ${alert.alertRef} ${alert.name} (${why})`,
      );
    } finally {
      await running.stop();
    }
  }

  const relaySetup = async () => (relay ??= await startRelaySetup());

  it.skipIf(skip('qr-site'))(
    'leaves no finding open on the QR site',
    async () => {
      const setup = await relaySetup();
      expect(await scanned(() => startQrSite(setup, join(reports, 'qr-site.service.log')))).toEqual(
        [],
      );
    },
    SCAN_TIMEOUT,
  );

  it.skipIf(skip('relay'))(
    'leaves no finding open on the relay’s functions',
    async () => {
      const setup = await relaySetup();
      expect(await scanned(() => Promise.resolve(relayTarget(setup)))).toEqual([]);
    },
    SCAN_TIMEOUT,
  );

  it.skipIf(skip('control-plane'))(
    'leaves no finding open on the Control Plane and the vendor web app',
    async () => {
      expect(
        await scanned(() => startControlPlane(join(reports, 'control-plane.service.log'))),
      ).toEqual([]);
    },
    SCAN_TIMEOUT,
  );

  it.skipIf(skip('local-server'))(
    'leaves no finding open on the local server and the console',
    async () => {
      expect(
        await scanned(() => startLocalServer(join(reports, 'local-server.service.log'))),
      ).toEqual([]);
    },
    SCAN_TIMEOUT,
  );
});
