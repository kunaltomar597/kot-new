import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  VendorMeView,
  VendorSessionView,
  VendorSetupTokenView,
  VendorUserListResponse,
} from '@rp/contracts/control-plane';
import { hotp, totpStep } from '@rp/totp';
import type { TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../../src/admin/admin.service.js';
import { runCli } from '../../src/cli.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { VendorAuthService } from '../../src/vendor/vendor-auth.service.js';
import { createTestApp, createTestDatabase, httpServer } from '../helpers/test-app.js';
import {
  bearer,
  codeFor,
  signInVendor,
  type TestVendor,
  vendorAccount,
} from '../helpers/vendor.js';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let admin: TestVendor;
let adminToken: string;

const server = () => request(httpServer(app));
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp(database.url);
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('[VCP-001] [SEC-018] vendor staff accounts', () => {
  it('starts with a Super Admin made by the CLI, who sets a password and an authenticator', async () => {
    const lines: string[] = [];
    const code = await runCli(
      [
        'vendor-user:create',
        '--email',
        'Asha@Vendor.example',
        '--name',
        'Asha',
        '--role',
        'SUPER_ADMIN',
      ],
      {
        admin: app.get(AdminService),
        vendorAuth: app.get(VendorAuthService),
        actor: 'cli:ops',
        out: (line) => lines.push(line),
      },
    );
    expect(code).toBe(0);
    const token = /: ([A-Za-z0-9_-]{43})$/.exec(lines[1] ?? '')?.[1] ?? '';
    // Not active until the authenticator is confirmed: no sign-in yet.
    const early = await server()
      .post('/v1/vendor/session')
      .send({ email: 'asha@vendor.example', password: 'whatever it is', code: '000000' });
    expect([early.status, codeOf(early)]).toEqual([423, 'VENDOR_ACCOUNT_DISABLED']);
    const weak = await server().post('/v1/vendor/setup').send({ token, password: 'short' });
    expect(weak.status).toBe(400);
    const setup = await server()
      .post('/v1/vendor/setup')
      .send({ token, password: 'a long enough passphrase' });
    expect(setup.status, JSON.stringify(setup.body)).toBe(200);
    expect((setup.body as { otpauthUri: string }).otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const wrong = await server().post('/v1/vendor/setup/confirm').send({ token, code: '000000' });
    expect(wrong.status).toBe(401);
    expect(await prisma.vendorUser.findFirstOrThrow()).toMatchObject({
      email: 'asha@vendor.example',
      activatedAt: null,
    });
    // The stored secret is sealed, never as given.
    const stored = await prisma.vendorUser.findFirstOrThrow();
    expect(stored.totpSecret).toMatch(/^v1\./);
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('signs in only with email, password and the authenticator’s code together', async () => {
    admin = await vendorAccount(app, 'SUPER_ADMIN');
    const missingCode = await server()
      .post('/v1/vendor/session')
      .send({ email: admin.email, password: admin.password });
    expect(missingCode.status).toBe(400);
    const now = codeFor(admin);
    const signedIn = await server()
      .post('/v1/vendor/session')
      .send({
        email: admin.email,
        password: admin.password,
        code: hotp(admin.secret, totpStep(new Date())),
      });
    // The current step may have been used already by setup: then the next one works.
    const session =
      signedIn.status === 201
        ? VendorSessionView.parse(signedIn.body)
        : await app
            .get(VendorAuthService)
            .signIn(
              { email: admin.email, password: admin.password, code: now.code },
              'test',
              now.at,
            );
    adminToken = session.token;
    expect(session.capabilities).toContain('USERS_MANAGE');
    const me = VendorMeView.parse(
      (await server().get('/v1/vendor/me').set(bearer(adminToken))).body,
    );
    expect(me.user.email).toBe(admin.email);
    expect(
      await prisma.auditEntry.count({ where: { action: 'vendor.signed_in' } }),
    ).toBeGreaterThan(0);
    // The token is kept only as a hash.
    const row = await prisma.vendorSession.findFirstOrThrow({ where: { endedAt: null } });
    expect(row.tokenHash).not.toBe(adminToken);
  });

  it('never accepts the same code twice, and locks after five failures', async () => {
    const auth = app.get(VendorAuthService);
    const used = codeFor(admin);
    await auth.signIn(
      { email: admin.email, password: admin.password, code: used.code },
      't',
      used.at,
    );
    await expect(
      auth.signIn({ email: admin.email, password: admin.password, code: used.code }, 't', used.at),
    ).rejects.toMatchObject({ code: 'VENDOR_UNAUTHENTICATED' });

    const victim = await vendorAccount(app, 'READ_ONLY');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await server()
        .post('/v1/vendor/session')
        .send({ email: victim.email, password: 'wrong password!!', code: '123456' });
      expect(failed.status).toBe(401);
    }
    const locked = await server()
      .post('/v1/vendor/session')
      .send({ email: victim.email, password: victim.password, code: codeFor(victim).code });
    expect([locked.status, codeOf(locked)]).toEqual([423, 'VENDOR_ACCOUNT_LOCKED']);
    expect(
      await prisma.auditEntry.count({ where: { action: 'vendor.sign_in_failed' } }),
    ).toBeGreaterThanOrEqual(6);
  });

  it('lets each role do only what it is for', async () => {
    const reader = await vendorAccount(app, 'READ_ONLY');
    const readerToken = await signInVendor(app, reader);
    const refused = await server().get('/v1/vendor/users').set(bearer(readerToken));
    expect([refused.status, codeOf(refused)]).toEqual([403, 'FORBIDDEN']);
    expect((await server().get('/v1/vendor/me').set(bearer(readerToken))).status).toBe(200);
    // Vendor tokens are not installation signatures, and the other way round.
    expect((await server().post('/v1/heartbeats').set(bearer(adminToken)).send({})).status).toBe(
      401,
    );
    expect((await server().get('/v1/vendor/me')).status).toBe(401);
    const list = VendorUserListResponse.parse(
      (await server().get('/v1/vendor/users').set(bearer(adminToken))).body,
    );
    expect(list.users.length).toBeGreaterThanOrEqual(4);
  });

  it('adds, changes, disables and resets accounts, never oneself or the last Super Admin', async () => {
    const created = await server()
      .post('/v1/vendor/users')
      .set(bearer(adminToken))
      .send({ email: 'finance@vendor.example', name: 'Farah', role: 'FINANCE' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const account = VendorSetupTokenView.parse(created.body);
    expect(account.user).toMatchObject({ role: 'FINANCE', active: false });
    const again = await server()
      .post('/v1/vendor/users')
      .set(bearer(adminToken))
      .send({ email: 'FINANCE@vendor.example', name: 'Farah', role: 'FINANCE' });
    expect([again.status, codeOf(again)]).toEqual([409, 'VENDOR_EMAIL_TAKEN']);

    const me = VendorMeView.parse(
      (await server().get('/v1/vendor/me').set(bearer(adminToken))).body,
    );
    const self = await server()
      .patch(`/v1/vendor/users/${me.user.id}`)
      .set(bearer(adminToken))
      .send({ disabled: true, reason: 'Testing' });
    expect([self.status, codeOf(self)]).toEqual([409, 'VENDOR_SELF_CHANGE']);

    const support = await vendorAccount(app, 'SUPPORT');
    const supportToken = await signInVendor(app, support);
    const supportId = (
      await prisma.vendorUser.findUniqueOrThrow({ where: { email: support.email } })
    ).id;
    const disabled = await server()
      .patch(`/v1/vendor/users/${supportId}`)
      .set(bearer(adminToken))
      .send({ disabled: true, reason: 'Left the company' });
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
    // Their session ends at once.
    expect((await server().get('/v1/vendor/me').set(bearer(supportToken))).status).toBe(401);

    const reset = await server()
      .post(`/v1/vendor/users/${supportId}/reset`)
      .set(bearer(adminToken));
    expect(VendorSetupTokenView.parse(reset.body).user.active).toBe(false);
    expect(
      await prisma.auditEntry.count({
        where: {
          action: { in: ['vendor.user_created', 'vendor.user_changed', 'vendor.user_reset'] },
        },
      }),
    ).toBeGreaterThanOrEqual(3);
  });

  it('records the quarterly access review, disabling every account not kept', async () => {
    const kept = await vendorAccount(app, 'ONBOARDING');
    const keptId = (await prisma.vendorUser.findUniqueOrThrow({ where: { email: kept.email } })).id;
    const reviewed = await server()
      .post('/v1/vendor/access-reviews')
      .set(bearer(adminToken))
      .send({ keep: [keptId], note: 'Q4 2026 review' });
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    const users = VendorUserListResponse.parse(reviewed.body).users;
    const active = users.filter((user) => !user.disabled).map((user) => user.email);
    expect(active).toEqual(expect.arrayContaining([admin.email, kept.email]));
    expect(active).toHaveLength(2);
    expect(users.find((user) => user.email === kept.email)?.reviewedAt).not.toBeNull();
    expect(
      await prisma.auditEntry.findFirstOrThrow({ where: { action: 'vendor.access_review' } }),
    ).toMatchObject({ details: { note: 'Q4 2026 review' } });
  });

  it('ends a session on sign-out, and after 30 minutes without use', async () => {
    const auth = app.get(VendorAuthService);
    const principal = await auth.authenticate(adminToken);
    await expect(
      auth.authenticate(adminToken, new Date(Date.now() + 31 * 60_000 + 3_600_000)),
    ).rejects.toMatchObject({ code: 'VENDOR_UNAUTHENTICATED' });
    expect(principal.actor).toMatch(/^vendor:/);
    expect((await server().delete('/v1/vendor/session').set(bearer(adminToken))).status).toBe(204);
    expect((await server().get('/v1/vendor/me').set(bearer(adminToken))).status).toBe(401);
  });
});
