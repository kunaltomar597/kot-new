import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  LoginResponse,
  StepUpResponse,
  TotpConfirmResponse,
  TotpEnrollmentResponse,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { base32Decode, hotp, totpStep } from '../../src/auth/totp.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { MatrixProbeController } from '../helpers/auth-probe.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

const PASSWORD = 'correct horse battery';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let owner: LoginResponse;
let secret: Buffer;
let recoveryCodes: string[];

beforeAll(async () => {
  // One clock for the whole file that only moves forward, so TOTP steps never repeat.
  vi.useFakeTimers({ toFake: ['Date'] });
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url, controllers: [MatrixProbeController] });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  owner = await signIn(app, kit, 'OWNER');
});

afterAll(async () => {
  vi.useRealTimers();
  await app.close();
  await database.drop();
});

const server = () => request(httpServer(app));
const as = (session: LoginResponse) => authHeaders(kit.deviceId, session.accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;
/** The code of the next 30-second step, so a code is never reused (replay protection). */
function nextCode(): string {
  vi.setSystemTime(Date.now() + 30_000);
  return hotp(secret, totpStep(new Date()));
}

describe('[AUTH-006] Owner account setup', () => {
  it('lets only the Owner set a password, enrol TOTP or step up', async () => {
    const manager = await signIn(app, kit, 'MANAGER');
    for (const [path, body] of [
      ['/api/v1/auth/owner/password', { newPassword: PASSWORD }],
      ['/api/v1/auth/owner/totp/enroll', {}],
      [
        '/api/v1/auth/step-up',
        { password: PASSWORD, secondFactor: { kind: 'TOTP', code: '123456' } },
      ],
    ] as const) {
      const response = await server().post(path).set(as(manager)).send(body);
      expect(response.status, path).toBe(403);
      expect(codeOf(response)).toBe('OWNER_ONLY');
    }
  });

  it('sets the first password without step-up, enrols TOTP and returns recovery codes', async () => {
    const setPassword = await server()
      .post('/api/v1/auth/owner/password')
      .set(as(owner))
      .send({ newPassword: PASSWORD });
    expect(setPassword.status).toBe(204);

    const enrolment = TotpEnrollmentResponse.parse(
      (await server().post('/api/v1/auth/owner/totp/enroll').set(as(owner))).body,
    );
    secret = base32Decode(enrolment.secret);
    expect(enrolment.otpauthUri).toContain(enrolment.secret);

    const wrong = await server()
      .post('/api/v1/auth/owner/totp/confirm')
      .set(as(owner))
      .send({ code: '000000' === nextCode() ? '111111' : '000000' });
    expect(codeOf(wrong)).toBe('INVALID_CODE');

    const confirmed = TotpConfirmResponse.parse(
      (
        await server()
          .post('/api/v1/auth/owner/totp/confirm')
          .set(as(owner))
          .send({ code: nextCode() })
      ).body,
    );
    recoveryCodes = confirmed.recoveryCodes;
    expect(new Set(recoveryCodes).size).toBe(10);

    const stored = await prisma.credential.findUniqueOrThrow({
      where: { staffId_kind: { staffId: kit.staff.OWNER, kind: 'TOTP' } },
    });
    expect(stored.secretHash.startsWith('v1.')).toBe(true);
    expect(stored.secretHash).not.toContain(enrolment.secret);
    const codes = await prisma.recoveryCode.findMany({ where: { staffId: kit.staff.OWNER } });
    expect(codes.map((row) => row.codeHash)).not.toContain(recoveryCodes[0]);
    for (const action of ['OWNER_PASSWORD_SET', 'TOTP_ENROLMENT_STARTED', 'TOTP_ENROLLED']) {
      expect(await prisma.auditLog.count({ where: { action } }), action).toBe(1);
    }
  });
});

describe('[AUTH-006] step-up for Owner-only actions', () => {
  it('requires a fresh password + TOTP step-up, valid for 5 minutes', async () => {
    const refused = await server().post('/api/v1/probe-matrix/DATA_ADMIN').set(as(owner));
    expect(codeOf(refused)).toBe('SECOND_FACTOR_REQUIRED');

    const wrongPassword = await server()
      .post('/api/v1/auth/step-up')
      .set(as(owner))
      .send({ password: 'not the password!', secondFactor: { kind: 'TOTP', code: nextCode() } });
    expect(codeOf(wrongPassword)).toBe('INVALID_CREDENTIALS');

    const code = nextCode();
    const stepUp = await server()
      .post('/api/v1/auth/step-up')
      .set(as(owner))
      .send({ password: PASSWORD, secondFactor: { kind: 'TOTP', code } });
    expect(stepUp.status).toBe(200);
    StepUpResponse.parse(stepUp.body);
    expect((await server().post('/api/v1/probe-matrix/DATA_ADMIN').set(as(owner))).status).toBe(
      200,
    );

    // The same code cannot be used twice.
    const replay = await server()
      .post('/api/v1/auth/step-up')
      .set(as(owner))
      .send({ password: PASSWORD, secondFactor: { kind: 'TOTP', code } });
    expect(codeOf(replay)).toBe('INVALID_CREDENTIALS');

    vi.setSystemTime(Date.now() + 5 * 60_000 + 1_000);
    const refreshed = LoginResponse.parse(
      (
        await server()
          .post('/api/v1/auth/refresh')
          .set(authHeaders(kit.deviceId))
          .send({ refreshToken: owner.refreshToken })
      ).body,
    );
    owner = refreshed;
    const expired = await server().post('/api/v1/probe-matrix/LICENSE_MANAGE').set(as(owner));
    expect(codeOf(expired)).toBe('SECOND_FACTOR_REQUIRED');
  });

  it('owner-login with password + TOTP starts a stepped-up session', async () => {
    const response = await server()
      .post('/api/v1/auth/owner-login')
      .set(authHeaders(kit.deviceId))
      .send({
        staffId: kit.staff.OWNER,
        password: PASSWORD,
        secondFactor: { kind: 'TOTP', code: nextCode() },
      });
    expect(response.status).toBe(200);
    const session = LoginResponse.parse(response.body);
    expect(session.secondFactorValidUntil).not.toBeNull();
    const allowed = await server()
      .post('/api/v1/probe-matrix/TAX_AND_INVOICE_SETTINGS')
      .set(authHeaders(kit.deviceId, session.accessToken));
    expect(allowed.status).toBe(200);
  });

  it('accepts each recovery code once', async () => {
    const login = (code: string) =>
      server()
        .post('/api/v1/auth/owner-login')
        .set(authHeaders(kit.deviceId))
        .send({
          staffId: kit.staff.OWNER,
          password: PASSWORD,
          secondFactor: { kind: 'RECOVERY_CODE', code },
        });
    expect((await login(recoveryCodes[0]!)).status).toBe(200);
    expect(codeOf(await login(recoveryCodes[0]!))).toBe('INVALID_CREDENTIALS');
  });

  it('refuses owner-login for anyone but the Owner, with the same message', async () => {
    const response = await server()
      .post('/api/v1/auth/owner-login')
      .set(authHeaders(kit.deviceId))
      .send({
        staffId: kit.staff.MANAGER,
        password: PASSWORD,
        secondFactor: { kind: 'TOTP', code: '123456' },
      });
    expect(codeOf(response)).toBe('INVALID_CREDENTIALS');
  });
});

describe('[AUTH-006] changing the Owner password', () => {
  it('needs the current password and a fresh step-up, and signs out other sessions', async () => {
    const other = await signIn(app, kit, 'OWNER');
    const withoutStepUp = await server()
      .post('/api/v1/auth/owner/password')
      .set(as(owner))
      .send({ currentPassword: PASSWORD, newPassword: 'a brand new passphrase' });
    expect(codeOf(withoutStepUp)).toBe('SECOND_FACTOR_REQUIRED');

    await server()
      .post('/api/v1/auth/step-up')
      .set(as(owner))
      .send({ password: PASSWORD, secondFactor: { kind: 'TOTP', code: nextCode() } })
      .expect(200);
    const wrongCurrent = await server()
      .post('/api/v1/auth/owner/password')
      .set(as(owner))
      .send({ currentPassword: 'definitely wrong', newPassword: 'a brand new passphrase' });
    expect(codeOf(wrongCurrent)).toBe('INVALID_CREDENTIALS');
    const missingCurrent = await server()
      .post('/api/v1/auth/owner/password')
      .set(as(owner))
      .send({ newPassword: 'a brand new passphrase' });
    expect(codeOf(missingCurrent)).toBe('CURRENT_PASSWORD_REQUIRED');

    const changed = await server()
      .post('/api/v1/auth/owner/password')
      .set(as(owner))
      .send({ currentPassword: PASSWORD, newPassword: 'a brand new passphrase' });
    expect(changed.status).toBe(204);
    const otherSession = await server()
      .get('/api/v1/auth/staff-tiles')
      .set(authHeaders(kit.deviceId, other.accessToken));
    expect(otherSession.status).toBe(200);
    const revoked = await prisma.session.findUniqueOrThrow({ where: { id: other.session.id } });
    expect(revoked.revokeReason).toBe('PASSWORD_CHANGED');
    expect(await prisma.auditLog.count({ where: { action: 'OWNER_PASSWORD_CHANGED' } })).toBe(1);
  });

  it('re-enrolling TOTP after confirmation needs a fresh step-up', async () => {
    vi.setSystemTime(Date.now() + 6 * 60_000);
    const refreshed = LoginResponse.parse(
      (
        await server()
          .post('/api/v1/auth/refresh')
          .set(authHeaders(kit.deviceId))
          .send({ refreshToken: owner.refreshToken })
      ).body,
    );
    owner = refreshed;
    const response = await server().post('/api/v1/auth/owner/totp/enroll').set(as(owner));
    expect(codeOf(response)).toBe('SECOND_FACTOR_REQUIRED');
  });
});
