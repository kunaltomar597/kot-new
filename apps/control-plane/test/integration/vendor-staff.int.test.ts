import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  VendorMeView,
  VendorResetRequestedView,
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
import type { CpError } from '../../src/errors/cp-error.js';
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
    // As a wrong password is answered: no answer says the account exists (threat CP-S1).
    expect([early.status, codeOf(early)]).toEqual([401, 'VENDOR_UNAUTHENTICATED']);
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

  it('counts tries sent together before checking them, and spends a code once', async () => {
    const auth = app.get(VendorAuthService);
    const victim = await vendorAccount(app, 'READ_ONLY');
    const victimId = (await prisma.vendorUser.findUniqueOrThrow({ where: { email: victim.email } }))
      .id;
    // Twelve guesses at once (the service, past the address's rate limit): five are checked, the
    // rest find the account locked.
    const statusOf = (result: PromiseSettledResult<unknown>) =>
      result.status === 'rejected' ? (result.reason as CpError).status : 201;
    const guesses = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        auth.signIn({ email: victim.email, password: 'a wrong password', code: '123456' }, 't'),
      ),
    );
    const statuses = guesses.map(statusOf);
    expect(statuses.filter((status) => status === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((status) => status === 423).length).toBeGreaterThanOrEqual(7);
    expect(
      await prisma.auditEntry.count({
        where: { action: 'vendor.sign_in_failed', targetId: victimId },
      }),
    ).toBeLessThanOrEqual(5);
    const right = codeFor(victim);
    await expect(
      auth.signIn({ email: victim.email, password: victim.password, code: right.code }, 't'),
    ).rejects.toMatchObject({ status: 423, code: 'VENDOR_ACCOUNT_LOCKED' });

    // The same code in two sign-ins at once: one session, the other refused.
    const twice = await vendorAccount(app, 'READ_ONLY');
    const used = codeFor(twice);
    const both = await Promise.allSettled(
      [0, 1].map(() =>
        auth.signIn(
          { email: twice.email, password: twice.password, code: used.code },
          't',
          used.at,
        ),
      ),
    );
    expect(both.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(both.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'VENDOR_UNAUTHENTICATED' },
    });
  });

  it('answers an unknown email, a disabled account and a wrong password alike, locks too', async () => {
    const auth = app.get(VendorAuthService);
    const tries = (email: string, password = 'a wrong password') =>
      auth.signIn({ email, password, code: '123456' }, 't').then(
        () => undefined,
        (error: unknown) => error as CpError,
      );
    const unknown = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      unknown.push(await tries('nobody@vendor.example'));
    }
    const wrong = { status: 401, code: 'VENDOR_UNAUTHENTICATED' };
    expect(unknown.map((error) => ({ status: error?.status, code: error?.code }))).toEqual([
      ...Array.from({ length: 5 }, () => wrong),
      { status: 423, code: 'VENDOR_ACCOUNT_LOCKED' },
    ]);
    expect(unknown[0]?.message).toBe('The email, password or code is not right.');

    const gone = await vendorAccount(app, 'SUPPORT');
    await prisma.vendorUser.update({
      where: { email: gone.email },
      data: { disabledAt: new Date() },
    });
    const disabled = await tries(gone.email, gone.password);
    expect({ status: disabled?.status, code: disabled?.code }).toEqual(wrong);
    expect(disabled?.message).toBe(unknown[0]?.message);
    expect(
      await prisma.auditEntry.findFirstOrThrow({
        where: {
          action: 'vendor.sign_in_failed',
          details: { path: ['email'], equals: gone.email },
        },
      }),
    ).toMatchObject({ details: { reason: 'CANNOT_SIGN_IN' } });
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
    const selfReset = await server()
      .post(`/v1/vendor/users/${me.user.id}/reset`)
      .set(bearer(adminToken));
    expect([selfReset.status, codeOf(selfReset)]).toEqual([409, 'VENDOR_SELF_CHANGE']);
    expect(
      await prisma.auditEntry.count({
        where: {
          action: { in: ['vendor.user_created', 'vendor.user_changed', 'vendor.user_reset'] },
        },
      }),
    ).toBeGreaterThanOrEqual(3);
  });

  it('resets a Super Admin only when two other Super Admins do it, within a day', async () => {
    const second = await vendorAccount(app, 'SUPER_ADMIN');
    const secondToken = await signInVendor(app, second);
    const target = await vendorAccount(app, 'SUPER_ADMIN');
    const targetToken = await signInVendor(app, target);
    const targetId = (await prisma.vendorUser.findUniqueOrThrow({ where: { email: target.email } }))
      .id;
    const resetAs = (token: string) =>
      server().post(`/v1/vendor/users/${targetId}/reset`).set(bearer(token));

    const asked = await resetAs(adminToken);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const waiting = VendorResetRequestedView.parse(asked.body).user;
    const adminRow = await prisma.vendorUser.findUniqueOrThrow({ where: { email: admin.email } });
    expect(waiting).toMatchObject({
      active: true,
      resetRequest: { requestedById: adminRow.id, requestedBy: adminRow.name },
    });
    expect(asked.body).not.toHaveProperty('setupToken');
    // Nothing changed yet: the account still signs in, and asking again changes nothing.
    expect((await server().get('/v1/vendor/me').set(bearer(targetToken))).status).toBe(200);
    expect((await resetAs(adminToken)).status).toBe(202);
    const listed = VendorUserListResponse.parse(
      (await server().get('/v1/vendor/users').set(bearer(secondToken))).body,
    ).users.find((user) => user.id === targetId);
    expect(listed?.resetRequest?.requestedById).toBe(adminRow.id);

    const done = await resetAs(secondToken);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(VendorSetupTokenView.parse(done.body).user).toMatchObject({
      active: false,
      resetRequest: null,
    });
    expect((await server().get('/v1/vendor/me').set(bearer(targetToken))).status).toBe(401);
    expect(
      await prisma.auditEntry.findFirstOrThrow({
        where: { action: 'vendor.user_reset', targetId },
      }),
    ).toMatchObject({ details: { requestedBy: expect.stringMatching(/^vendor:/) as unknown } });
    expect(
      await prisma.auditEntry.count({ where: { action: 'vendor.user_reset_requested', targetId } }),
    ).toBe(1);

    // A request lapses after 24 hours: the next Super Admin then asks afresh.
    const auth = app.get(VendorAuthService);
    const other = await vendorAccount(app, 'SUPER_ADMIN');
    const otherId = (await prisma.vendorUser.findUniqueOrThrow({ where: { email: other.email } }))
      .id;
    const first = await auth.authenticate(adminToken);
    const later = await auth.authenticate(secondToken);
    const start = new Date();
    expect((await auth.reset(otherId, first, start)).done).toBe(false);
    const lapsed = await auth.reset(otherId, later, new Date(start.getTime() + 25 * 3_600_000));
    expect(lapsed.done).toBe(false);
    expect(lapsed.view.user.resetRequest?.requestedById).toBe(later.userId);

    // Nor does a request from a Super Admin who has since been disabled.
    const third = await vendorAccount(app, 'SUPER_ADMIN');
    const thirdId = (await prisma.vendorUser.findUniqueOrThrow({ where: { email: third.email } }))
      .id;
    expect((await auth.reset(thirdId, later)).done).toBe(false);
    await prisma.vendorUser.update({
      where: { id: later.userId },
      data: { disabledAt: new Date() },
    });
    const after = await auth.reset(thirdId, first);
    expect(after.done).toBe(false);
    expect(after.view.user.resetRequest?.requestedById).toBe(first.userId);
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
