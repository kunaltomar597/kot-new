import type { INestApplication } from '@nestjs/common';
import {
  HeartbeatResponse,
  RelayProvisioningView,
  SupportNoteListResponse,
  SupportNoteView,
} from '@rp/contracts/control-plane';
import { startRelay, type TestRelay } from '@rp/relay/testing';
import type { TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { relayDigest } from '../../src/support/support.service.js';
import { enrolledInstallation, heartbeatBody, signedPost } from '../helpers/fleet.js';
import { createTestApp, createTestDatabase, httpServer } from '../helpers/test-app.js';
import type { TestInstallation } from '../helpers/test-installation.js';
import { bearer, signInVendor, vendorAccount } from '../helpers/vendor.js';

let database: TestDatabase;
let relay: TestRelay;
let app: INestApplication;
let prisma: PrismaService;
let pc: TestInstallation;
let tenantId: string;
const tokens: Record<string, string> = {};

const server = () => request(httpServer(app));
const as = (role: string) => bearer(tokens[role] ?? '');

beforeAll(async () => {
  database = await createTestDatabase();
  relay = await startRelay({ adminUrl: inject('pgAdminUrl'), runId: inject('pgRunId') });
  app = await createTestApp(database.url, { relayDatabaseUrl: relay.databaseUrl });
  prisma = app.get(PrismaService);
  for (const role of ['ONBOARDING', 'SUPPORT', 'FINANCE', 'READ_ONLY'] as const) {
    tokens[role] = await signInVendor(app, await vendorAccount(app, role));
  }
  pc = await enrolledInstallation(app);
  tenantId = (await prisma.installation.findUniqueOrThrow({ where: { id: pc.id ?? '' } })).tenantId;
});

afterAll(async () => {
  await app.close();
  await relay.stop();
  await database.drop();
});

async function beat(digest: string | null) {
  const response = await signedPost(
    app,
    pc,
    '/v1/heartbeats',
    heartbeatBody({ relay: { credentialDigest: digest } }),
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return HeartbeatResponse.parse(response.body);
}

describe('[VCP-007] support notes', () => {
  it('lets support staff add notes everyone may read; notes are never changed', async () => {
    const byFinance = await server()
      .post(`/v1/vendor/tenants/${tenantId}/notes`)
      .set(as('FINANCE'))
      .send({ body: 'Called about the invoice' });
    expect(byFinance.status).toBe(403);
    const added = await server()
      .post(`/v1/vendor/tenants/${tenantId}/notes`)
      .set(as('SUPPORT'))
      .send({ body: 'Printer on T4 jams; advised a new roll.' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const note = SupportNoteView.parse(added.body);
    expect(note.authorName).toMatch(/^Staff /);
    const list = SupportNoteListResponse.parse(
      (await server().get(`/v1/vendor/tenants/${tenantId}/notes`).set(as('READ_ONLY'))).body,
    );
    expect(list.notes.map((entry) => entry.body)).toEqual([
      'Printer on T4 jams; advised a new roll.',
    ]);
    await expect(
      prisma.supportNote.update({ where: { id: note.id }, data: { body: 'edited' } }),
    ).rejects.toThrow(/append-only/);
  });
});

describe('[VCP-002] [VCP-008] the restaurant in the QR relay', () => {
  let first: string;

  it('lets Onboarding provision it; its PC gets the credential until it holds it', async () => {
    expect(
      (await server().post(`/v1/vendor/tenants/${tenantId}/relay`).set(as('SUPPORT'))).status,
    ).toBe(403);
    const provisioned = await server()
      .post(`/v1/vendor/tenants/${tenantId}/relay`)
      .set(as('ONBOARDING'));
    expect(provisioned.status, JSON.stringify(provisioned.body)).toBe(200);
    expect(RelayProvisioningView.parse(provisioned.body)).toMatchObject({ delivered: false });

    const answer = await beat(null);
    first = answer.relayCredential ?? '';
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The relay keeps only its hash and knows the restaurant by it.
    const known = await relay.admin.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM relay.verify_credential($1)',
      [first],
    );
    expect(known.rows[0]?.tenant_id).toBe(tenantId);
    // Sent again while the PC has not got it; not once it says it holds it.
    expect((await beat(null)).relayCredential).toBe(first);
    expect((await beat(relayDigest(first))).relayCredential).toBeNull();
    const view = RelayProvisioningView.parse(
      (await server().get(`/v1/vendor/tenants/${tenantId}/relay`).set(as('READ_ONLY'))).body,
    );
    expect(view.delivered).toBe(true);
    // Stored sealed in the Control Plane, never as given.
    const row = await prisma.relayProvisioning.findUniqueOrThrow({ where: { tenantId } });
    expect(row.credentialSealed).not.toContain(first);
  });

  it('gives a new credential at once, revoking the old one', async () => {
    const rotated = await server()
      .post(`/v1/vendor/tenants/${tenantId}/relay`)
      .set(as('ONBOARDING'));
    expect(RelayProvisioningView.parse(rotated.body)).toMatchObject({ delivered: false });
    const second = (await beat(relayDigest(first))).relayCredential ?? '';
    expect(second).not.toBe(first);
    const old = await relay.admin.query('SELECT tenant_id FROM relay.verify_credential($1)', [
      first,
    ]);
    expect(old.rows).toEqual([]);
    expect(
      await prisma.auditEntry.count({
        where: { action: { in: ['relay.provisioned', 'relay.credential_rotated'] } },
      }),
    ).toBe(2);
  });
});
