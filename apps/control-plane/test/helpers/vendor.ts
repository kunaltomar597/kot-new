import type { INestApplication } from '@nestjs/common';
import {
  STEP_UP_HEADER,
  type VendorRole,
  VendorSessionView,
  VendorSetupResponse,
} from '@rp/contracts/control-plane';
import { base32Decode, hotp, totpStep } from '@rp/totp';
import { VendorAuthService } from '../../src/vendor/vendor-auth.service.js';

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

/**
 * Creates and sets up an account through the service (the API's own steps, and their limit of 20
 * tries per address, are tested in vendor-staff.int.test.ts).
 */
export async function vendorAccount(
  app: INestApplication,
  role: VendorRole,
  actor = 'cli:test',
): Promise<TestVendor> {
  accounts += 1;
  const email = `staff${String(accounts)}@vendor.example`;
  const password = 'correct horse battery staple';
  const auth = app.get(VendorAuthService);
  const created = await auth.create({ email, name: `Staff ${String(accounts)}`, role }, actor);
  const setup = VendorSetupResponse.parse(await auth.setup(created.setupToken, password));
  const vendor: TestVendor = { email, password, secret: base32Decode(setup.secret), step: 0 };
  const { code, at } = codeFor(vendor);
  await auth.confirm(created.setupToken, code, at);
  return vendor;
}

/** Signs in through the service at the code's own time (so codes are never reused). */
export async function signInVendor(app: INestApplication, vendor: TestVendor): Promise<string> {
  const { code, at } = codeFor(vendor);
  const session = await app
    .get(VendorAuthService)
    .signIn({ email: vendor.email, password: vendor.password, code }, 'test', at);
  const { token } = VendorSessionView.parse(session);
  knownSession(app, vendor, token);
  return token;
}

/** Lets `bearer` add step-up codes for a session the test opened itself. */
export function knownSession(app: INestApplication, vendor: TestVendor, token: string): void {
  signedIn.set(token, { app, vendor });
}

const signedIn = new Map<string, { app: INestApplication; vendor: TestVendor }>();

/**
 * The step-up header (CP-S2) with a fresh code, valid at the time the code is for: the service's
 * clock is moved there, as the guard reads it.
 */
export function stepUp(token: string): Record<string, string> {
  const who = signedIn.get(token);
  if (who === undefined) return {};
  const { code, at } = codeFor(who.vendor);
  who.app.get(VendorAuthService).clock = () => at;
  return { [STEP_UP_HEADER]: code };
}

/**
 * The bearer header of a session, with a fresh step-up code too, so a test need not think of it;
 * the tests of the step-up itself send their own headers with `bearerOnly`.
 */
export const bearer = (token: string) => ({ authorization: `Bearer ${token}`, ...stepUp(token) });

export const bearerOnly = (token: string) => ({ authorization: `Bearer ${token}` });
