import { generateKeyPairSync } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ApiError, EnrolResponse } from '@rp/contracts/control-plane';
import type { TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../../src/admin/admin.service.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { ACTOR } from '../helpers/fleet.js';
import { createTestApp, createTestDatabase, httpServer } from '../helpers/test-app.js';
import { TestInstallation } from '../helpers/test-installation.js';

let database: TestDatabase;
let app: INestApplication;
let admin: AdminService;
let prisma: PrismaService;
let tenantId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp(database.url);
  admin = app.get(AdminService);
  prisma = app.get(PrismaService);
  tenantId = (await admin.createTenant('Enrolment Dhaba', ACTOR)).id;
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const enrol = (body: unknown) =>
  request(httpServer(app))
    .post('/v1/enrolments')
    .send(body as object);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;

describe('[SEC-002] [ONB-003] enrolling a restaurant PC (ADR-0012)', () => {
  it('registers the public key with a one-time code and audits it', async () => {
    const issued = await admin.createInstallation({ tenantId, name: 'Counter PC' }, ACTOR);
    const pc = TestInstallation.create();
    const response = await enrol(pc.enrolRequest(issued.code));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const enrolled = EnrolResponse.parse(response.body);
    expect(enrolled).toMatchObject({
      installationId: issued.installationId,
      tenantId,
      name: 'Counter PC',
      channel: 'STABLE',
    });
    const row = await prisma.installation.findUniqueOrThrow({
      where: { id: issued.installationId },
    });
    expect(row).toMatchObject({ status: 'ACTIVE', publicKey: pc.publicKeyBase64 });
    expect(row.enrolmentCodeHash).toBeNull();
    const audit = await prisma.auditEntry.findMany({
      where: { targetType: 'installation', targetId: issued.installationId },
      orderBy: { id: 'asc' },
    });
    expect(audit.map((entry) => [entry.action, entry.actor])).toEqual([
      ['installation.created', ACTOR],
      ['installation.enrolled', `installation:${issued.installationId}`],
    ]);
    // The code is gone from the database and the audit log.
    expect(JSON.stringify(audit.map((entry) => entry.details))).not.toContain(issued.code);

    // Used once: a second PC cannot enrol with the same code.
    const again = await enrol(TestInstallation.create().enrolRequest(issued.code));
    expect(again.status).toBe(401);
    expect(codeOf(again)).toBe('ENROLMENT_INVALID');
  });

  it('refuses a proof made with another key, an unknown or expired code, or a non-Ed25519 key', async () => {
    const issued = await admin.createInstallation({ tenantId, name: 'Kitchen PC' }, ACTOR);
    const pc = TestInstallation.create();
    const other = generateKeyPairSync('ed25519').privateKey;
    expect(codeOf(await enrol(pc.enrolRequest(issued.code, other)))).toBe('ENROLMENT_INVALID');
    expect(codeOf(await enrol(pc.enrolRequest('ABCD-EFGH-JKLM-NP23')))).toBe('ENROLMENT_INVALID');

    const ecdsa = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    expect(
      codeOf(
        await enrol({
          ...pc.enrolRequest(issued.code),
          publicKey: ecdsa.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        }),
      ),
    ).toBe('ENROLMENT_INVALID');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaKey = rsa.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    expect(codeOf(await enrol({ ...pc.enrolRequest(issued.code), publicKey: rsaKey }))).toBe(
      'VALIDATION_FAILED',
    );

    await prisma.installation.update({
      where: { id: issued.installationId },
      data: { enrolmentCodeExpiresAt: new Date(Date.now() - 1_000) },
    });
    expect(codeOf(await enrol(pc.enrolRequest(issued.code)))).toBe('ENROLMENT_INVALID');
    // A failed attempt changes nothing.
    const row = await prisma.installation.findUniqueOrThrow({
      where: { id: issued.installationId },
    });
    expect(row.status).toBe('PENDING');

    // A fresh code for the same installation works.
    const fresh = await admin.issueEnrolmentCode(issued.installationId, ACTOR);
    expect((await enrol(pc.enrolRequest(fresh.code))).status).toBe(201);
    await expect(admin.issueEnrolmentCode(issued.installationId, ACTOR)).rejects.toMatchObject({
      code: 'ALREADY_ENROLLED',
    });
  });

  it('validates the request against the contract', async () => {
    const pc = TestInstallation.create();
    expect(codeOf(await enrol({ ...pc.enrolRequest('ABCD-EFGH-JKLM-NP23'), code: 'abc' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(
      codeOf(await enrol({ ...pc.enrolRequest('ABCD-EFGH-JKLM-NP23'), tenantId: 'mine' })),
    ).toBe('VALIDATION_FAILED');
    const broken = await request(httpServer(app))
      .post('/v1/enrolments')
      .set('content-type', 'application/json')
      .send('{"code":');
    expect(codeOf(broken)).toBe('INVALID_JSON');
  });
});

describe('[SEC-009] enrolment rate limit', () => {
  it('refuses the 11th attempt within a minute from one address', async () => {
    const own = await createTestDatabase();
    const ownApp = await createTestApp(own.url);
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 11; attempt += 1) {
        const response = await request(httpServer(ownApp))
          .post('/v1/enrolments')
          .send(TestInstallation.create().enrolRequest('ZZZZ-ZZZZ-ZZZZ-ZZZZ'));
        statuses.push(response.status);
      }
      expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
    } finally {
      await ownApp.close();
      await own.drop();
    }
  });
});
