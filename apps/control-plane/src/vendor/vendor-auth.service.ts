import { hash, verify } from '@node-rs/argon2';
import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateVendorUserRequest,
  type UpdateVendorUserRequest,
  type VendorCapability,
  vendorCapabilitiesOf,
  type VendorMeView,
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
import { PrismaService } from '../database/prisma.service.js';
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

export function vendorUserView(user: VendorUser): VendorUserView {
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
  };
}

/**
 * Vendor staff accounts and sessions (VCP-001, SEC-018). An account is created with a one-time
 * setup token, given to the person out of band; they choose a password and add an authenticator,
 * and only then can sign in, always with both. Five failures lock the account for 15 minutes.
 * Sessions last 8 hours, 30 minutes without use. Every sign-in, failure and change is audited;
 * the token is kept only as a hash.
 */
@Injectable()
export class VendorAuthService {
  private readonly key: Buffer;
  private dummyHash: Promise<string> | undefined;

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
    const failed = async (reason: string) => {
      await this.prisma.transaction(async (tx) => {
        if (user !== null) {
          const failures = user.failedSignIns + 1;
          await tx.vendorUser.update({
            where: { id: user.id },
            data:
              failures >= MAX_FAILURES
                ? { failedSignIns: 0, lockedUntil: new Date(now.getTime() + LOCK_MS) }
                : { failedSignIns: failures },
          });
        }
        await this.audit.record(tx, {
          actor: user === null ? 'vendor:unknown' : `vendor:${user.id}`,
          action: 'vendor.sign_in_failed',
          targetType: 'vendor_user',
          targetId: user?.id ?? null,
          details: { reason, email: input.email, address },
        });
      });
      return unauthorised('The email, password or code is not right.');
    };
    if (user === null) {
      await this.spendHashTime(input.password);
      throw await failed('UNKNOWN_EMAIL');
    }
    if (user.disabledAt !== null || user.activatedAt === null) {
      throw new CpError(423, 'VENDOR_ACCOUNT_DISABLED', 'This account cannot sign in.');
    }
    if (user.lockedUntil !== null && user.lockedUntil > now) {
      throw new CpError(
        423,
        'VENDOR_ACCOUNT_LOCKED',
        'Too many failed sign-ins. Try again in 15 minutes.',
        { lockedUntil: user.lockedUntil.toISOString() },
      );
    }
    if (
      user.passwordHash === null ||
      !(await this.checkPassword(user.passwordHash, input.password))
    ) {
      throw await failed('PASSWORD');
    }
    const step =
      user.totpSecret === null
        ? null
        : verifyTotp(open(this.key, user.totpSecret), input.code, now, user.totpLastStep);
    if (step === null) throw await failed('CODE');

    const token = newToken();
    const expiresAt = new Date(now.getTime() + SESSION_HOURS * HOUR_MS);
    const signedIn = await this.prisma.transaction(async (tx) => {
      const updated = await tx.vendorUser.update({
        where: { id: user.id },
        data: { totpLastStep: step, failedSignIns: 0, lockedUntil: null, lastSignInAt: now },
      });
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
      return updated;
    });
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      user: vendorUserView(signedIn),
      capabilities: [...vendorCapabilitiesOf(signedIn.role)],
    };
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

  async list(): Promise<VendorUserView[]> {
    const users = await this.prisma.vendorUser.findMany({ orderBy: [{ name: 'asc' }] });
    return users.map(vendorUserView);
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

  /** A lost password or authenticator: everything cleared, a new setup token (shown once). */
  async reset(userId: string, principal: VendorPrincipal): Promise<VendorSetupTokenView> {
    const token = newToken();
    const setupExpiresAt = new Date(Date.now() + SETUP_HOURS * HOUR_MS);
    return this.prisma.transaction(async (tx) => {
      const user = await tx.vendorUser.findUnique({ where: { id: userId } });
      if (user === null) throw new CpError(404, 'NOT_FOUND', 'There is no such account.');
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
        },
      });
      await tx.vendorSession.updateMany({
        where: { userId, endedAt: null },
        data: { endedAt: new Date() },
      });
      await this.audit.record(tx, {
        actor: principal.actor,
        action: 'vendor.user_reset',
        targetType: 'vendor_user',
        targetId: userId,
      });
      return {
        user: vendorUserView(reset),
        setupToken: token,
        setupExpiresAt: setupExpiresAt.toISOString(),
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
