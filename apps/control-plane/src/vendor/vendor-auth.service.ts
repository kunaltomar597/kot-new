import { hash, verify } from '@node-rs/argon2';
import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateVendorUserRequest,
  type UpdateVendorUserRequest,
  type VendorCapability,
  vendorCapabilitiesOf,
  type VendorMeView,
  VENDOR_RESET_REQUEST_HOURS,
  type VendorResetRequestedView,
  type VendorRole,
  type VendorSessionView,
  type VendorSetupResponse,
  type VendorSetupTokenView,
  type VendorUserView,
} from '@rp/contracts/control-plane';
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from '@rp/totp';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { CP_CONFIG, type CpConfig } from '../config/cp-config.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { CpError } from '../errors/cp-error.js';
import type { VendorUser } from '../generated/prisma/client.js';
import { newId } from '../ids.js';
import { open, seal, secretKeyOf } from './secret-key.js';

const HOUR_MS = 3_600_000;
/** A setup token (new account or reset) is valid this long. */
const SETUP_HOURS = 72;
/** A session ends after this long, or after this long without use (SEC-018). */
const SESSION_HOURS = 8;
const IDLE_MS = 30 * 60_000;
/** Failed sign-ins before the account locks, and for how long. */
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
/** Emails without an account that can sign in, whose failures are counted in memory. */
const MAX_UNKNOWN_TRACKED = 10_000;
const ISSUER = 'Restaurant Platform (vendor)';

/** A signed-in vendor staff member, as the guard puts it on the request. */
export interface VendorPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly role: VendorRole;
  /** `vendor:<user id>`, the actor every audit entry names. */
  readonly actor: string;
  readonly expiresAt: Date;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

function unauthorised(message = 'Sign in again.'): CpError {
  return new CpError(401, 'VENDOR_UNAUTHENTICATED', message);
}

/** The one answer to a wrong email, password or code, and to an account that cannot sign in. */
const notRight = () => unauthorised('The email, password or code is not right.');

function lockedError(until: Date): CpError {
  return new CpError(
    423,
    'VENDOR_ACCOUNT_LOCKED',
    'Too many failed sign-ins. Try again in 15 minutes.',
    { lockedUntil: until.toISOString() },
  );
}

/** An account that can sign in: set up, not disabled, with a password and an authenticator. */
function canSignIn(
  user: VendorUser | null,
): user is VendorUser & { passwordHash: string; totpSecret: string } {
  if (user === null) return false;
  return (
    user.activatedAt !== null &&
    user.disabledAt === null &&
    user.passwordHash !== null &&
    user.totpSecret !== null
  );
}

/** A Super Admin's open reset request, if it has not lapsed. */
function openResetRequest(
  user: VendorUser,
  now: Date,
): { requestedBy: string; requestedAt: Date; expiresAt: Date } | null {
  if (user.resetRequestedBy === null || user.resetRequestedAt === null) return null;
  const expiresAt = new Date(
    user.resetRequestedAt.getTime() + VENDOR_RESET_REQUEST_HOURS * HOUR_MS,
  );
  return expiresAt > now
    ? { requestedBy: user.resetRequestedBy, requestedAt: user.resetRequestedAt, expiresAt }
    : null;
}

export function vendorUserView(
  user: VendorUser,
  names: ReadonlyMap<string, string> = new Map(),
  now = new Date(),
): VendorUserView {
  const reset = openResetRequest(user, now);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    active: user.activatedAt !== null && user.disabledAt === null,
    disabled: user.disabledAt !== null,
    lockedUntil:
      user.lockedUntil !== null && user.lockedUntil > new Date()
        ? user.lockedUntil.toISOString()
        : null,
    lastSignInAt: user.lastSignInAt?.toISOString() ?? null,
    reviewedAt: user.reviewedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    resetRequest:
      reset === null
        ? null
        : {
            requestedById: reset.requestedBy,
            requestedBy: names.get(reset.requestedBy) ?? 'A Super Admin',
            requestedAt: reset.requestedAt.toISOString(),
            expiresAt: reset.expiresAt.toISOString(),
          },
  };
}

/** The authenticator asked for again (CP-S2): a new code is needed to go on. */
function stepUpRequired(): CpError {
  return new CpError(
    403,
    'STEP_UP_REQUIRED',
    'Enter a new code from your authenticator app to do this.',
  );
}

/**
 * Vendor staff accounts and sessions (VCP-001, SEC-018). An account is created with a one-time
 * setup token, given to the person out of band; they choose a password and add an authenticator,
 * and only then can sign in, always with both. Five failures lock the account for 15 minutes.
 * Sessions last 8 hours, 30 minutes without use. Every sign-in, failure and change is audited;
 * the token is kept only as a hash.
 *
 * Each try is counted before the password is checked, in one statement, so tries sent together
 * cannot pass five; a code's step is spent in the same way. An email without an account, and an
 * account that is disabled or not set up, get the same answers as a wrong password, locks
 * included (threat CP-S1). A Super Admin's reset takes two other Super Admins (threat CP-E3).
 */
@Injectable()
export class VendorAuthService {
  private readonly key: Buffer;
  private dummyHash: Promise<string> | undefined;
  /** Failures for emails that cannot sign in, so they lock as an account would (per instance). */
  private readonly unknownFailures = new Map<string, { failures: number; lockedUntil: number }>();

  constructor(
    @Inject(CP_CONFIG) config: CpConfig,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    this.key = secretKeyOf(config);
  }

  // ---------------------------------------------------------------- setting up an account

  /** Step 1: the password; answers the authenticator to add (its secret kept sealed). */
  async setup(token: string, password: string): Promise<VendorSetupResponse> {
    const user = await this.bySetupToken(token);
    const secret = generateTotpSecret();
    await this.prisma.vendorUser.update({
      where: { id: user.id },
      data: {
        passwordHash: await this.hashPassword(password),
        totpSecret: seal(this.key, secret),
        totpLastStep: null,
      },
    });
    return { otpauthUri: otpauthUri(ISSUER, user.email, secret), secret: base32Encode(secret) };
  }

  /** Step 2: a code from the new authenticator; the account is active and the token spent. */
  async confirm(token: string, code: string, now = new Date()): Promise<VendorUserView> {
    const user = await this.bySetupToken(token);
    if (user.totpSecret === null || user.passwordHash === null) {
      throw unauthorised('Choose a password first.');
    }
    const step = verifyTotp(open(this.key, user.totpSecret), code, now, null);
    if (step === null) throw unauthorised('That code is not right. Try the next one.');
    return this.prisma.transaction(async (tx) => {
      const active = await tx.vendorUser.update({
        where: { id: user.id },
        data: {
          activatedAt: now,
          totpLastStep: step,
          setupTokenHash: null,
          setupExpiresAt: null,
          failedSignIns: 0,
          lockedUntil: null,
        },
      });
      await this.audit.record(tx, {
        actor: `vendor:${user.id}`,
        action: 'vendor.account_set_up',
        targetType: 'vendor_user',
        targetId: user.id,
      });
      return vendorUserView(active);
    });
  }

  // ---------------------------------------------------------------- signing in and out

  async signIn(
    input: { email: string; password: string; code: string },
    address: string,
    now = new Date(),
  ): Promise<VendorSessionView> {
    const user = await this.prisma.vendorUser.findUnique({ where: { email: input.email } });
    const audited = (reason: string) =>
      this.prisma.transaction((tx) =>
        this.audit.record(tx, {
          actor: user === null ? 'vendor:unknown' : `vendor:${user.id}`,
          action: 'vendor.sign_in_failed',
          targetType: 'vendor_user',
          targetId: user?.id ?? null,
          details: { reason, email: input.email, address },
        }),
      );
    if (!canSignIn(user)) {
      // Answered as a wrong password would be, so no answer says which emails have an account.
      const locked = this.unknownLockedUntil(input.email, now);
      if (locked !== null) throw lockedError(locked);
      await this.spendHashTime(input.password);
      this.countUnknownFailure(input.email, now);
      await audited(user === null ? 'UNKNOWN_EMAIL' : 'CANNOT_SIGN_IN');
      throw notRight();
    }
    // The try is counted before the slow check: tries sent together each take one of the five.
    const tries = await this.prisma.$queryRaw<{ failures: number }[]>`
      UPDATE vendor_users SET failed_sign_ins = failed_sign_ins + 1, updated_at = ${now}
      WHERE id = ${user.id}::uuid AND (locked_until IS NULL OR locked_until <= ${now})
      RETURNING failed_sign_ins AS failures`;
    const counted = tries[0]?.failures;
    if (counted === undefined || counted > MAX_FAILURES) {
      throw lockedError(await this.lockIfOver(user.id, counted, now));
    }
    const failed = async (reason: string) => {
      if (counted >= MAX_FAILURES) await this.lockIfOver(user.id, counted, now);
      await audited(reason);
      return notRight();
    };
    if (!(await this.checkPassword(user.passwordHash, input.password))) {
      throw await failed('PASSWORD');
    }
    const step = verifyTotp(open(this.key, user.totpSecret), input.code, now, user.totpLastStep);
    if (step === null) throw await failed('CODE');

    const token = newToken();
    const expiresAt = new Date(now.getTime() + SESSION_HOURS * HOUR_MS);
    const signedIn = await this.prisma.transaction(async (tx) => {
      // The step is spent only if no other sign-in spent it (or a later one) meanwhile.
      const spent = await tx.vendorUser.updateMany({
        where: {
          id: user.id,
          OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }],
        },
        data: { totpLastStep: step, failedSignIns: 0, lockedUntil: null, lastSignInAt: now },
      });
      if (spent.count === 0) return null;
      await tx.vendorSession.create({
        data: {
          id: newId(),
          userId: user.id,
          tokenHash: sha256(token),
          lastSeenAt: now,
          expiresAt,
          address,
        },
      });
      await this.audit.record(tx, {
        actor: `vendor:${user.id}`,
        action: 'vendor.signed_in',
        targetType: 'vendor_user',
        targetId: user.id,
        details: { address },
      });
      return tx.vendorUser.findUniqueOrThrow({ where: { id: user.id } });
    });
    if (signedIn === null) throw await failed('CODE_USED');
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      user: vendorUserView(signedIn),
      capabilities: [...vendorCapabilitiesOf(signedIn.role)],
    };
  }

  /** Replaced by tests, which sign in at the time of their own codes. */
  clock: () => Date = () => new Date();

  /**
   * Asks for the authenticator again (CP-S2): the code must be one never used, so the sign-in's
   * does not count. A wrong code counts towards the same lock as a wrong sign-in; the session
   * stays (403, not 401).
   */
  async stepUp(principal: VendorPrincipal, code: string | undefined): Promise<void> {
    const now = this.clock();
    const user = await this.prisma.vendorUser.findUnique({ where: { id: principal.userId } });
    if (!canSignIn(user)) throw unauthorised();
    if (user.lockedUntil !== null && user.lockedUntil > now) throw lockedError(user.lockedUntil);
    // No code: asked for one, and nothing counts against the lock.
    if (code === undefined) throw stepUpRequired();
    const step = verifyTotp(open(this.key, user.totpSecret), code, now, user.totpLastStep);
    const spent =
      step === null
        ? 0
        : (
            await this.prisma.vendorUser.updateMany({
              where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
              data: { totpLastStep: step, failedSignIns: 0 },
            })
          ).count;
    if (spent === 1) return;
    // A wrong or used code counts towards the lock, like a wrong sign-in.
    const tries = await this.prisma.$queryRaw<{ failures: number }[]>`
      UPDATE vendor_users SET failed_sign_ins = failed_sign_ins + 1, updated_at = ${now}
      WHERE id = ${user.id}::uuid RETURNING failed_sign_ins AS failures`;
    const counted = tries[0]?.failures;
    if (counted !== undefined && counted >= MAX_FAILURES) {
      await this.lockIfOver(user.id, counted, now);
    }
    await this.prisma.transaction((tx) =>
      this.audit.record(tx, {
        actor: principal.actor,
        action: 'vendor.step_up_failed',
        targetType: 'vendor_user',
        targetId: user.id,
        details: {},
      }),
    );
    throw stepUpRequired();
  }

  /** The session behind a bearer token, kept alive; refused when ended, expired or idle. */
  async authenticate(token: string, now = new Date()): Promise<VendorPrincipal> {
    const session = await this.prisma.vendorSession.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: true },
    });
    if (
      session?.endedAt !== null ||
      session.expiresAt <= now ||
      now.getTime() - session.lastSeenAt.getTime() > IDLE_MS ||
      session.user.disabledAt !== null
    ) {
      throw unauthorised();
    }
    await this.prisma.vendorSession.update({
      where: { id: session.id },
      data: { lastSeenAt: now },
    });
    return {
      userId: session.userId,
      sessionId: session.id,
      role: session.user.role,
      actor: `vendor:${session.userId}`,
      expiresAt: session.expiresAt,
    };
  }

  async signOut(principal: VendorPrincipal): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      await tx.vendorSession.update({
        where: { id: principal.sessionId },
        data: { endedAt: new Date() },
      });
      await this.audit.record(tx, {
        actor: principal.actor,
        action: 'vendor.signed_out',
        targetType: 'vendor_user',
        targetId: principal.userId,
      });
    });
  }

  async me(principal: VendorPrincipal): Promise<VendorMeView> {
    const user = await this.prisma.vendorUser.findUniqueOrThrow({
      where: { id: principal.userId },
    });
    return {
      user: vendorUserView(user),
      capabilities: [...vendorCapabilitiesOf(user.role)],
      expiresAt: principal.expiresAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------- accounts (USERS_MANAGE)

  async list(now = new Date()): Promise<VendorUserView[]> {
    const users = await this.prisma.vendorUser.findMany({ orderBy: [{ name: 'asc' }] });
    const names = new Map(users.map((user) => [user.id, user.name]));
    return users.map((user) => vendorUserView(user, names, now));
  }

  /** A new account and its setup token (shown once). `actor` is `vendor:<id>` or `cli:<name>`. */
  async create(request: CreateVendorUserRequest, actor: string): Promise<VendorSetupTokenView> {
    const existing = await this.prisma.vendorUser.findUnique({ where: { email: request.email } });
    if (existing !== null) {
      throw new CpError(409, 'VENDOR_EMAIL_TAKEN', 'An account has that email.');
    }
    const token = newToken();
    const setupExpiresAt = new Date(Date.now() + SETUP_HOURS * HOUR_MS);
    return this.prisma.transaction(async (tx) => {
      const user = await tx.vendorUser.create({
        data: {
          id: newId(),
          email: request.email,
          name: request.name,
          role: request.role,
          setupTokenHash: sha256(token),
          setupExpiresAt,
        },
      });
      await this.audit.record(tx, {
        actor,
        action: 'vendor.user_created',
        targetType: 'vendor_user',
        targetId: user.id,
        details: { email: user.email, role: user.role },
      });
      return {
        user: vendorUserView(user),
        setupToken: token,
        setupExpiresAt: setupExpiresAt.toISOString(),
      };
    });
  }

  /** Role changes and disabling, with a reason; never oneself, never the last Super Admin. */
  async update(
    userId: string,
    change: UpdateVendorUserRequest,
    principal: VendorPrincipal,
  ): Promise<VendorUserView> {
    if (userId === principal.userId) {
      throw new CpError(
        409,
        'VENDOR_SELF_CHANGE',
        'Ask another Super Admin to change your account.',
      );
    }
    return this.prisma.transaction(async (tx) => {
      const user = await tx.vendorUser.findUnique({ where: { id: userId } });
      if (user === null) throw new CpError(404, 'NOT_FOUND', 'There is no such account.');
      const role = change.role ?? user.role;
      const disabled = change.disabled ?? user.disabledAt !== null;
      if (user.role === 'SUPER_ADMIN' && (role !== 'SUPER_ADMIN' || disabled)) {
        const others = await tx.vendorUser.count({
          where: {
            role: 'SUPER_ADMIN',
            disabledAt: null,
            activatedAt: { not: null },
            id: { not: userId },
          },
        });
        if (others === 0) {
          throw new CpError(409, 'LAST_SUPER_ADMIN', 'Keep at least one active Super Admin.');
        }
      }
      const updated = await tx.vendorUser.update({
        where: { id: userId },
        data: {
          role,
          disabledAt: disabled ? (user.disabledAt ?? new Date()) : null,
        },
      });
      if (disabled) {
        await tx.vendorSession.updateMany({
          where: { userId, endedAt: null },
          data: { endedAt: new Date() },
        });
      }
      await this.audit.record(tx, {
        actor: principal.actor,
        action: 'vendor.user_changed',
        targetType: 'vendor_user',
        targetId: userId,
        details: {
          reason: change.reason,
          before: { role: user.role, disabled: user.disabledAt !== null },
          after: { role, disabled },
        },
      });
      return vendorUserView(updated);
    });
  }

  /**
   * A lost password or authenticator: everything cleared, a new setup token (shown once). Never
   * one's own account. A Super Admin's account takes two other Super Admins (threat CP-E3): the
   * first call records the request (`requested`), and the reset happens only when another Super
   * Admin resets it too within 24 hours; the setup token goes to that second one.
   */
  async reset(
    userId: string,
    principal: VendorPrincipal,
    now = new Date(),
  ): Promise<
    | { readonly done: true; readonly view: VendorSetupTokenView }
    | { readonly done: false; readonly view: VendorResetRequestedView }
  > {
    if (userId === principal.userId) {
      throw new CpError(
        409,
        'VENDOR_SELF_CHANGE',
        'Ask another Super Admin to reset your account.',
      );
    }
    const token = newToken();
    const setupExpiresAt = new Date(now.getTime() + SETUP_HOURS * HOUR_MS);
    return this.prisma.transaction(async (tx) => {
      // Locked, so two Super Admins pressing Reset at once make one request, then one reset.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text FROM vendor_users WHERE id = ${userId}::uuid FOR UPDATE`;
      const user =
        locked.length === 0 ? null : await tx.vendorUser.findUnique({ where: { id: userId } });
      if (user === null) throw new CpError(404, 'NOT_FOUND', 'There is no such account.');
      // A request counts only while its asker is still an active Super Admin.
      const pending = openResetRequest(user, now);
      const asker =
        pending === null
          ? null
          : await tx.vendorUser.findUnique({ where: { id: pending.requestedBy } });
      const asked =
        asker?.role === 'SUPER_ADMIN' && asker.disabledAt === null && asker.activatedAt !== null
          ? pending
          : null;
      if (
        user.role === 'SUPER_ADMIN' &&
        (asked === null || asked.requestedBy === principal.userId)
      ) {
        const requested = await tx.vendorUser.update({
          where: { id: userId },
          data: {
            resetRequestedBy: principal.userId,
            resetRequestedAt: asked?.requestedAt ?? now,
          },
        });
        if (asked === null) {
          await this.audit.record(tx, {
            actor: principal.actor,
            action: 'vendor.user_reset_requested',
            targetType: 'vendor_user',
            targetId: userId,
          });
        }
        const names = await this.namesOf(tx, [principal.userId]);
        return { done: false, view: { user: vendorUserView(requested, names, now) } };
      }
      const reset = await tx.vendorUser.update({
        where: { id: userId },
        data: {
          passwordHash: null,
          totpSecret: null,
          totpLastStep: null,
          activatedAt: null,
          setupTokenHash: sha256(token),
          setupExpiresAt,
          failedSignIns: 0,
          lockedUntil: null,
          resetRequestedBy: null,
          resetRequestedAt: null,
        },
      });
      await tx.vendorSession.updateMany({
        where: { userId, endedAt: null },
        data: { endedAt: now },
      });
      await this.audit.record(tx, {
        actor: principal.actor,
        action: 'vendor.user_reset',
        targetType: 'vendor_user',
        targetId: userId,
        ...(asked !== null &&
          user.role === 'SUPER_ADMIN' && {
            details: { requestedBy: `vendor:${asked.requestedBy}` },
          }),
      });
      return {
        done: true,
        view: {
          user: vendorUserView(reset),
          setupToken: token,
          setupExpiresAt: setupExpiresAt.toISOString(),
        },
      };
    });
  }

  /**
   * The quarterly access review (SEC-018): the accounts kept are marked reviewed; every other
   * account (except the reviewer's) is disabled and its sessions end.
   */
  async review(
    keep: readonly string[],
    note: string,
    principal: VendorPrincipal,
    now = new Date(),
  ): Promise<VendorUserView[]> {
    const kept = new Set([...keep, principal.userId]);
    await this.prisma.transaction(async (tx) => {
      const users = await tx.vendorUser.findMany({ where: { disabledAt: null } });
      const removed = users.filter((user) => !kept.has(user.id));
      if (users.filter((user) => kept.has(user.id) && user.role === 'SUPER_ADMIN').length === 0) {
        throw new CpError(409, 'LAST_SUPER_ADMIN', 'Keep at least one active Super Admin.');
      }
      await tx.vendorUser.updateMany({
        where: { id: { in: [...kept] }, disabledAt: null },
        data: { reviewedAt: now },
      });
      if (removed.length > 0) {
        const ids = removed.map((user) => user.id);
        await tx.vendorUser.updateMany({ where: { id: { in: ids } }, data: { disabledAt: now } });
        await tx.vendorSession.updateMany({
          where: { userId: { in: ids }, endedAt: null },
          data: { endedAt: now },
        });
      }
      await this.audit.record(tx, {
        actor: principal.actor,
        action: 'vendor.access_review',
        targetType: 'vendor_users',
        targetId: null,
        details: {
          note,
          kept: [...kept],
          disabled: removed.map((user) => ({ id: user.id, email: user.email, role: user.role })),
        },
      });
    });
    return this.list();
  }

  /** Whether a principal's role allows a capability: the guard's question. */
  static allows(principal: VendorPrincipal, capability: VendorCapability): boolean {
    return vendorCapabilitiesOf(principal.role).includes(capability);
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Locks the account when a failure reached the limit, or a try came over it, and says until
   * when it is locked. The lock may be another try's: then it is read, not moved.
   */
  private async lockIfOver(userId: string, counted: number | undefined, now: Date): Promise<Date> {
    const until = new Date(now.getTime() + LOCK_MS);
    if (counted !== undefined) {
      await this.prisma.vendorUser.updateMany({
        where: { id: userId, OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
        data: { failedSignIns: 0, lockedUntil: until },
      });
    }
    const row = await this.prisma.vendorUser.findUnique({
      where: { id: userId },
      select: { lockedUntil: true },
    });
    return row?.lockedUntil ?? until;
  }

  /** Until when an email without an account that can sign in answers as locked, if it does. */
  private unknownLockedUntil(email: string, now: Date): Date | null {
    const entry = this.unknownFailures.get(email);
    return entry !== undefined && entry.lockedUntil > now.getTime()
      ? new Date(entry.lockedUntil)
      : null;
  }

  private countUnknownFailure(email: string, now: Date): void {
    if (this.unknownFailures.size >= MAX_UNKNOWN_TRACKED) {
      for (const [key, entry] of this.unknownFailures) {
        if (entry.lockedUntil <= now.getTime()) this.unknownFailures.delete(key);
      }
      if (this.unknownFailures.size >= MAX_UNKNOWN_TRACKED) this.unknownFailures.clear();
    }
    const entry = this.unknownFailures.get(email) ?? { failures: 0, lockedUntil: 0 };
    const failures = entry.failures + 1;
    this.unknownFailures.set(
      email,
      failures >= MAX_FAILURES
        ? { failures: 0, lockedUntil: now.getTime() + LOCK_MS }
        : { failures, lockedUntil: entry.lockedUntil },
    );
  }

  private async namesOf(
    tx: TransactionClient,
    ids: readonly string[],
  ): Promise<Map<string, string>> {
    const rows = await tx.vendorUser.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  private async bySetupToken(token: string): Promise<VendorUser> {
    const user = await this.prisma.vendorUser.findUnique({
      where: { setupTokenHash: sha256(token) },
    });
    const expiresAt = user?.setupExpiresAt ?? null;
    if (user === null || expiresAt === null || expiresAt <= new Date()) {
      throw unauthorised('This setup link is not valid. Ask a Super Admin for a new one.');
    }
    if (user.disabledAt !== null) {
      throw new CpError(423, 'VENDOR_ACCOUNT_DISABLED', 'This account cannot sign in.');
    }
    return user;
  }

  private hashPassword(password: string): Promise<string> {
    return hash(password, { memoryCost: 19_456, timeCost: 2, parallelism: 1, secret: this.key });
  }

  private async checkPassword(encoded: string, password: string): Promise<boolean> {
    try {
      return await verify(encoded, password, { secret: this.key });
    } catch {
      return false;
    }
  }

  /** Same time for an unknown email as for a wrong password, so neither gives the other away. */
  private async spendHashTime(password: string): Promise<void> {
    this.dummyHash ??= this.hashPassword(randomBytes(16).toString('hex'));
    await this.checkPassword(await this.dummyHash, password);
  }
}
