import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  FleetAlertListResponse,
  HeartbeatResponse,
  VendorInstallationView,
  VendorReleaseListResponse,
  VendorReleaseView,
} from '@rp/contracts/control-plane';
import { rolloutBucket } from '@rp/domain';
import type { TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { ReleasesService } from '../../src/releases/releases.service.js';
import { enrolledInstallation, heartbeatBody, signedPost } from '../helpers/fleet.js';
import { createTestApp, createTestDatabase, httpServer } from '../helpers/test-app.js';
import type { TestInstallation } from '../helpers/test-installation.js';
import { bearer, signInVendor, vendorAccount } from '../helpers/vendor.js';

/**
 * Staged rollouts (P7-04a, UPD-002, UPD-003, UPD-004): a release offered to a share of the
 * channel's PCs, widened, paused and halted; a PC held at a version; a hotfix for one PC; and a
 * rollout halted by itself when the PCs that install it fail.
 */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let pcs: TestInstallation[] = [];
let token: string;
let support: string;
const server = () => request(httpServer(app));

const at = (version: string) => heartbeatBody({ components: [{ name: 'RESTAURANT_PC', version }] });

async function heartbeat(pc: TestInstallation, body: string) {
  const response = await signedPost(app, pc, '/v1/heartbeats', body);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return HeartbeatResponse.parse(response.body);
}

async function offered(pc: TestInstallation, version = '1.0.0'): Promise<string | null> {
  return (await heartbeat(pc, at(version))).update?.version ?? null;
}

async function publish(body: Record<string, unknown>) {
  const response = await server()
    .post('/v1/vendor/releases')
    .set(bearer(token))
    .send({
      component: 'RESTAURANT_PC',
      channel: 'STABLE',
      url: `https://downloads.example.com/rp/${String(body.version)}/setup.exe`,
      sha256: 'e'.repeat(64),
      sizeBytes: 150_000_000,
      ...body,
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return VendorReleaseView.parse(response.body);
}

async function rollout(id: string, body: Record<string, unknown>, as = token) {
  return server()
    .put(`/v1/vendor/releases/${id}/rollout`)
    .set(bearer(as))
    .send({ reason: 'Staged rollout', cohort: [], ...body });
}

async function releaseView(id: string): Promise<VendorReleaseView> {
  const list = VendorReleaseListResponse.parse(
    (await server().get('/v1/vendor/releases').set(bearer(token))).body,
  );
  const found = list.releases.find((entry) => entry.id === id);
  if (found === undefined) throw new Error('No such release');
  return found;
}

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp(database.url, {
    rolloutSilentMinutes: 30,
    rolloutErrorSpike: 50,
    rolloutMinFailures: 2,
    rolloutMaxFailurePercent: 20,
  });
  prisma = app.get(PrismaService);
  pcs = [];
  for (let index = 0; index < 12; index += 1) pcs.push(await enrolledInstallation(app, 'STABLE'));
  token = await signInVendor(app, await vendorAccount(app, 'SUPER_ADMIN'));
  support = await signInVendor(app, await vendorAccount(app, 'SUPPORT'));
}, 120_000);

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('[UPD-003] [UPD-002] staged rollout', () => {
  it('offers a release to the share of PCs its rollout reaches, and widens without losing any', async () => {
    const release = await publish({ version: '1.1.0', rolloutPercent: 0 });
    expect(release.rollout).toMatchObject({ percent: 0, state: 'ACTIVE', haltReason: null });
    for (const pc of pcs) expect(await offered(pc)).toBeNull();

    // Support may look but not change it.
    expect((await rollout(release.id, { percent: 50, state: 'ACTIVE' }, support)).status).toBe(403);
    expect((await rollout(release.id, { percent: 50, state: 'ACTIVE' })).status).toBe(200);
    const reached = pcs.filter((pc) => rolloutBucket(pc.id ?? '', release.id) < 50);
    for (const pc of pcs) {
      expect(await offered(pc), pc.id).toBe(reached.includes(pc) ? '1.1.0' : null);
    }

    // The pilot PC, whatever its bucket; and pausing stops all new offers.
    const outside = pcs.find((pc) => !reached.includes(pc));
    if (outside === undefined) throw new Error('Every PC is in the first half');
    expect(
      (await rollout(release.id, { percent: 50, state: 'ACTIVE', cohort: [outside.id] })).status,
    ).toBe(200);
    expect(await offered(outside)).toBe('1.1.0');
    expect((await rollout(release.id, { percent: 50, state: 'PAUSED' })).status).toBe(200);
    for (const pc of pcs) expect(await offered(pc)).toBeNull();

    const unknown = await rollout(release.id, {
      percent: 50,
      state: 'ACTIVE',
      cohort: [randomUUID()],
    });
    expect(unknown.status).toBe(422);
    expect((await rollout(release.id, { percent: 100, state: 'ACTIVE' })).status).toBe(200);
    for (const pc of pcs) expect(await offered(pc)).toBe('1.1.0');

    const audit = await prisma.auditEntry.findMany({
      where: { action: 'release.rollout_changed', targetId: release.id },
    });
    expect(audit).toHaveLength(4);
  });

  it('holds a PC at a version, and gives a hotfix to its PC only', async () => {
    const [held, fixed, other] = pcs;
    if (held === undefined || fixed === undefined || other === undefined) throw new Error('PCs');
    await publish({ version: '1.2.0' });
    const pinned = await server()
      .put(`/v1/vendor/installations/${held.id}/pin`)
      .set(bearer(token))
      .send({ version: '1.1.0', reason: 'Waiting for the new printer driver' });
    expect(pinned.status, JSON.stringify(pinned.body)).toBe(200);
    expect(VendorInstallationView.parse(pinned.body).pinnedVersion).toBe('1.1.0');
    expect(await offered(held)).toBe('1.1.0');
    expect(await offered(held, '1.1.0')).toBeNull();
    expect(await offered(other)).toBe('1.2.0');

    const hotfix = await publish({
      version: '1.2.1-hotfix.1',
      targetInstallationId: fixed.id,
      securityCritical: true,
    });
    expect(hotfix.target).toEqual({ id: fixed.id, name: 'Main PC' });
    const answer = await heartbeat(fixed, at('1.2.0'));
    expect(answer.update).toMatchObject({ version: '1.2.1-hotfix.1', securityCritical: true });
    expect(await offered(other, '1.2.0')).toBeNull();

    const released = await server()
      .put(`/v1/vendor/installations/${held.id}/pin`)
      .set(bearer(token))
      .send({ version: null, reason: 'Driver fixed' });
    expect(VendorInstallationView.parse(released.body).pinnedVersion).toBeNull();
    expect(await offered(held, '1.1.0')).toBe('1.2.0');
  });

  it('halts a rollout by itself when the PCs installing it fail, and alerts each failure', async () => {
    const release = await publish({ version: '1.3.0' });
    const [first, second, third] = pcs.slice(3);
    if (first === undefined || second === undefined || third === undefined) throw new Error('PCs');
    const report = (version: string, outcome: string, error: string | null = null) =>
      heartbeatBody({
        components: [{ name: 'RESTAURANT_PC', version }],
        updateReport: { version: '1.3.0', outcome, at: new Date().toISOString(), error },
      });

    // One installs it fine.
    await heartbeat(first, report('1.2.0', 'INSTALLING'));
    await heartbeat(first, report('1.3.0', 'INSTALLED'));
    // One fails its health check and rolls back.
    await heartbeat(second, report('1.2.0', 'INSTALLING'));
    await heartbeat(second, report('1.2.0', 'ROLLED_BACK', 'Health check failed: database'));
    expect((await releaseView(release.id)).rollout.state).toBe('ACTIVE');
    // One starts and is never heard from again.
    await heartbeat(third, report('1.2.0', 'INSTALLING'));
    const releases = app.get(ReleasesService);
    expect(await releases.sweep(new Date(Date.now() + 10 * 60_000))).toBe(0);
    expect(await releases.sweep(new Date(Date.now() + 31 * 60_000))).toBe(1);

    const halted = await releaseView(release.id);
    expect(halted.rollout.state).toBe('HALTED');
    expect(halted.rollout.haltReason).toBe(
      'Halted automatically: 2 failed or rolled back, of 3 PCs that installed it.',
    );
    expect(halted.installs).toEqual({ attempts: 3, installed: 1, failures: 2, errorSpikes: 0 });
    // Nobody new is offered it.
    expect(await offered(pcs[9] ?? first, '1.2.0')).toBeNull();
    expect(
      await prisma.auditEntry.count({
        where: { action: 'release.rollout_halted', actor: 'system:rollout' },
      }),
    ).toBe(1);

    const alerts = FleetAlertListResponse.parse(
      (await server().get('/v1/vendor/fleet/alerts').set(bearer(token))).body,
    ).alerts.filter((alert) => alert.kind === 'UPDATE_FAILED');
    const all = await prisma.fleetAlert.findMany({ where: { kind: 'UPDATE_FAILED' } });
    expect(
      alerts.map((alert) => alert.installationId).sort(),
      JSON.stringify({ all, second: second.id, third: third.id }),
    ).toEqual([second.id, third.id].sort());
    // The PC that rolled back runs the release later: its alert closes.
    await heartbeat(second, at('1.3.0'));
    const open = FleetAlertListResponse.parse(
      (await server().get('/v1/vendor/fleet/alerts').set(bearer(token))).body,
    ).alerts.filter((alert) => alert.kind === 'UPDATE_FAILED');
    expect(open.map((alert) => alert.installationId)).toEqual([third.id]);
    // The silent PC was replaced: support closes its alert with a reason.
    const closed = await server()
      .post(`/v1/vendor/fleet/alerts/${open[0]?.id ?? ''}/resolve`)
      .set(bearer(support))
      .send({ reason: 'PC replaced, restored from backup' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  });

  it('counts a server error spike after an install as a failure', async () => {
    const release = await publish({ version: '1.4.0' });
    const [first, second] = pcs.slice(6);
    if (first === undefined || second === undefined) throw new Error('PCs');
    for (const pc of [first, second]) {
      await heartbeat(pc, at('1.4.0'));
      await heartbeat(
        pc,
        heartbeatBody({
          components: [{ name: 'RESTAURANT_PC', version: '1.4.0' }],
          errorCount: 60,
        }),
      );
    }
    const view = await releaseView(release.id);
    expect(view.installs).toMatchObject({ installed: 2, errorSpikes: 2 });
    expect(view.rollout.state).toBe('HALTED');
    expect(view.rollout.haltReason).toMatch(/2 with an error spike/);
  });
});

describe('[UPD-006] the component version matrix published with every release', () => {
  const matrix = (release: string) => ({
    release,
    clientApi: { current: '1.3', oldest: '1.2' },
    components: [
      { name: 'server', version: release },
      { name: 'node', version: '24.21.0' },
    ],
    clients: [{ kind: 'waiter-app', version: release, minimumVersion: '1.6.0' }],
    pagerProtocol: 1,
  });

  it('keeps the matrix with the release and sends it to the PCs offered it', async () => {
    const pc = pcs.at(-1);
    if (pc === undefined) throw new Error('PCs');
    const published = await publish({
      version: '9.0.0-matrix.1',
      targetInstallationId: pc.id,
      matrix: matrix('9.0.0-matrix.1'),
    });
    expect(published.matrix).toEqual(matrix('9.0.0-matrix.1'));
    expect((await releaseView(published.id)).matrix?.clientApi).toEqual({
      current: '1.3',
      oldest: '1.2',
    });
    const answer = await heartbeat(pc, at('1.0.0'));
    expect(answer.update).toMatchObject({
      version: '9.0.0-matrix.1',
      matrix: { clientApi: { current: '1.3', oldest: '1.2' } },
    });
    const audit = await prisma.auditEntry.findFirst({
      where: { action: 'release.published', targetId: published.id },
    });
    expect(audit?.details).toMatchObject({ clientApi: { current: '1.3', oldest: '1.2' } });
  });

  it('refuses a matrix of another release, and publishes a release without one', async () => {
    const mismatch = await server()
      .post('/v1/vendor/releases')
      .set(bearer(token))
      .send({
        component: 'RESTAURANT_PC',
        channel: 'PILOT',
        version: '9.1.0',
        url: 'https://downloads.example.com/rp/9.1.0/setup.exe',
        sha256: 'e'.repeat(64),
        sizeBytes: 150_000_000,
        matrix: matrix('9.0.0'),
      });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body).toMatchObject({ code: 'MATRIX_MISMATCH' });
    const plain = await publish({ version: '9.1.0', channel: 'PILOT' });
    expect(plain.matrix).toBeNull();
  });
});

describe('[PGR-011] [UPD-003] pager firmware released through each PC', () => {
  const firmware = (version: string, extra: Record<string, unknown> = {}) =>
    publish({
      component: 'PAGER_FIRMWARE',
      version,
      url: `https://downloads.example.com/rp/pager/rp-pager-${version}.bin`,
      sizeBytes: 1_500_000,
      ...extra,
    });
  const serving = (version: string | null, report: Record<string, unknown> | null = null) =>
    heartbeatBody({
      components: [{ name: 'RESTAURANT_PC', version: '1.0.0' }],
      pagerFirmware: {
        version,
        report: report === null ? null : { at: new Date().toISOString(), error: null, ...report },
      },
    });

  it('offers firmware only to PCs that pass it on, by its rollout, whatever the PC is held at', async () => {
    const release = await firmware('2.0.0');
    const pc = await enrolledInstallation(app, 'STABLE');
    // A PC before P2-04b says nothing about firmware and is offered none.
    expect((await heartbeat(pc, at('1.0.0'))).pagerFirmware).toBeNull();
    // Holding the PC at a version holds its installer, not its pagers' firmware.
    await app.get(ReleasesService).pin(pc.id ?? '', '1.0.0', 'Pilot', 'cli:test');
    const answer = await heartbeat(pc, serving(null));
    expect(answer.pagerFirmware).toEqual({
      update: expect.objectContaining({
        component: 'PAGER_FIRMWARE',
        version: '2.0.0',
        url: 'https://downloads.example.com/rp/pager/rp-pager-2.0.0.bin',
      }) as unknown,
      halted: false,
    });
    expect(answer.update?.component ?? null).not.toBe('PAGER_FIRMWARE');
    // Serving it: nothing newer, and the PC counts as having taken it.
    expect((await heartbeat(pc, serving('2.0.0'))).pagerFirmware).toEqual({
      update: null,
      halted: false,
    });
    expect((await releaseView(release.id)).installs).toMatchObject({ attempts: 1, installed: 1 });
    // A rollout at 0 % reaches no PC.
    await firmware('2.0.1', { rolloutPercent: 0 });
    expect((await heartbeat(pc, serving('2.0.0'))).pagerFirmware?.update).toBeNull();
  });

  it('halts the rollout when pagers roll back from it, and tells the PCs serving it to stop', async () => {
    const release = await firmware('3.0.0');
    const [first, second, third] = [
      await enrolledInstallation(app, 'STABLE'),
      await enrolledInstallation(app, 'STABLE'),
      await enrolledInstallation(app, 'STABLE'),
    ];
    for (const pc of [first, second, third]) {
      expect((await heartbeat(pc, serving('2.0.0'))).pagerFirmware?.update?.version).toBe('3.0.0');
      await heartbeat(pc, serving('3.0.0', { version: '3.0.0', outcome: 'INSTALLED' }));
    }
    // A PC that refused the image (its signature, say) counts as a failure too.
    const refusing = await enrolledInstallation(app, 'STABLE');
    await heartbeat(
      refusing,
      serving('2.0.0', { version: '3.0.0', outcome: 'FAILED', error: 'BAD_SIGNATURE' }),
    );
    expect((await releaseView(release.id)).rollout.state).toBe('ACTIVE');
    await heartbeat(first, serving('3.0.0', { version: '3.0.0', outcome: 'ROLLED_BACK' }));
    // Reported again until answered: counted once.
    await heartbeat(first, serving('3.0.0', { version: '3.0.0', outcome: 'ROLLED_BACK' }));

    const halted = await releaseView(release.id);
    expect(halted.rollout.state).toBe('HALTED');
    expect(halted.installs).toEqual({ attempts: 4, installed: 2, failures: 2, errorSpikes: 0 });
    expect((await heartbeat(second, serving('3.0.0'))).pagerFirmware).toEqual({
      update: null,
      halted: true,
    });
    // Firmware failures count in the rollout only: no fleet alert about the PCs' own updates.
    expect(
      await prisma.fleetAlert.count({
        where: {
          kind: 'UPDATE_FAILED',
          installationId: { in: [first.id ?? '', refusing.id ?? ''] },
        },
      }),
    ).toBe(0);
  });
});
