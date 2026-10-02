import type { INestApplication } from '@nestjs/common';
import {
  type VendorRole,
  VendorSessionView,
  VendorSetupResponse,
} from '@rp/contracts/control-plane';
import { base32Decode, hotp, totpStep } from '@rp/totp';
import request from 'supertest';
import { VendorAuthService } from '../../src/vendor/vendor-auth.service.js';
import { httpServer } from './test-app.js';

/** A vendor staff member as the tests drive one: their password and authenticator secret. */
export interface TestVendor {
  readonly email: string;
  readonly password: string;
  readonly secret: Buffer;
  /** Authenticator steps used, so each sign-in gets a fresh code. */
  step: number;
}

let accounts = 0;

/** The authenticator's code for a step after the last used, as an app would show it later. */
export function codeFor(vendor: TestVendor): { code: string; at: Date } {
  vendor.step = Math.max(vendor.step + 1, totpStep(new Date()));
  return { code: hotp(vendor.secret, vendor.step), at: new Date(vendor.step * 30_000) };
}

/** Creates an account through the service and sets it up through the API. */
export async function vendorAccount(
  app: INestApplication,
  role: VendorRole,
  actor = 'cli:test',
): Promise<TestVendor> {
  accounts += 1;
  const email = `staff${String(accounts)}@vendor.example`;
  const password = 'correct horse battery staple';
  const created = await app
    .get(VendorAuthService)
    .create({ email, name: `Staff ${String(accounts)}`, role }, actor);
  const setup = VendorSetupResponse.parse(
    (
      await request(httpServer(app))
        .post('/v1/vendor/setup')
        .send({ token: created.setupToken, password })
    ).body,
  );
  const vendor: TestVendor = { email, password, secret: base32Decode(setup.secret), step: 0 };
  const { code } = codeFor(vendor);
  const confirmed = await request(httpServer(app))
    .post('/v1/vendor/setup/confirm')
    .send({ token: created.setupToken, code });
  if (confirmed.status !== 200) throw new Error(JSON.stringify(confirmed.body));
  return vendor;
}

/** Signs in through the service at the code's own time (so codes are never reused). */
export async function signInVendor(app: INestApplication, vendor: TestVendor): Promise<string> {
  const { code, at } = codeFor(vendor);
  const session = await app
    .get(VendorAuthService)
    .signIn({ email: vendor.email, password: vendor.password, code }, 'test', at);
  return VendorSessionView.parse(session).token;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
