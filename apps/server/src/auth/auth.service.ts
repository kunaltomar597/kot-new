import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  LoginResponse,
  OverrideRequest,
  OverrideResponse,
  OwnerLoginRequest,
  OwnerPasswordRequest,
  PinLoginRequest,
  SecondFactor,
  StaffTilesResponse,
  StepUpRequest,
  StepUpResponse,
  TotpConfirmResponse,
  TotpEnrollmentResponse,
} from '@rp/contracts';
import { canApproveOverride, grantFor, type Role } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import type { AppError } from '../errors/app-error.js';
import type { CredentialKind } from '../generated/prisma/enums.js';
import { authErrors } from './auth-errors.js';
import { type AuthSettings, AuthSettingsService } from './auth-settings.js';
import { CredentialHasher } from './credential-hasher.js';
import type { AuthenticatedDevice } from './device.js';
import type { ConsumedOverride, Principal } from './principal.js';
import { RateLimiter } from './rate-limiter.js';
import { open, seal } from './secret-box.js';
import { SECRET_STORE, type SecretStore } from './secret-store.js';
import { SessionService, type SessionStaff } from './session.service.js';
import { randomToken, sha256Hex } from './tokens.js';
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from './totp.js';

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECOVERY_CODES = 10;

interface CredentialRow {
  readonly id: string;
  readonly secretHash: string;
  readonly failedAttempts: number;
  readonly failureWindowStartedAt: Date | null;
  readonly lockedUntil: Date | null;
}

type Outcome<T> = { readonly ok: T } | { readonly error: AppError };

function recoveryCode(): string {
  const pick = () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)] ?? 'A';
  const half = () => Array.from({ length: 4 }, pick).join('');
  return `${half()}-${half()}`;
}

/**
 * Sign-in and the actions around it (AUTH-001 to AUTH-006, AUTH-011, AUTH-013). Failed attempts,
 * lockouts, sign-ins and overrides are audited in the same transaction as the state they change;
 * failures are committed before the error is returned, so they always count.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: CredentialHasher,
    private readonly sessions: SessionService,
    private readonly settings: AuthSettingsService,
    private readonly audit: AuditService,
    private readonly limiter: RateLimiter,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
  ) {}

  /** Login tiles: active staff of this device's restaurant who have a PIN (AUTH-001). */
  async staffTiles(device: AuthenticatedDevice): Promise<StaffTilesResponse> {
    const staff = await this.prisma.staff.findMany({
      where: {
        restaurantId: device.restaurantId,
        active: true,
        archivedAt: null,
        credentials: { some: { kind: 'PIN' } },
      },
      include: { role: true },
      orderBy: { displayName: 'asc' },
    });
    return {
      staff: staff.map((person) => ({
        staffId: person.id,
        displayName: person.displayName,
        role: person.role.baseRole,
        photoId: person.photoId,
      })),
    };
  }

  async pinLogin(device: AuthenticatedDevice, request: PinLoginRequest): Promise<LoginResponse> {
    const settings = await this.settings.get(device.restaurantId);
    this.throttle(`login:${device.deviceId}`, settings);
    const now = new Date();

    const outcome = await this.prisma.transaction(
      async (
        tx,
      ): Promise<
        Outcome<{ staff: SessionStaff; session: Awaited<ReturnType<SessionService['create']>> }>
      > => {
        const staff = await this.activeStaff(tx, device.restaurantId, request.staffId);
        const credential = staff === null ? null : await this.lockedCredential(tx, staff.id, 'PIN');
        const base = { tx, device, staffId: request.staffId, method: 'PIN' as const };
        if (staff === null || credential === null) {
          await this.hasher.verifyNothing(request.pin);
          return { error: await this.failure(base, 'Unknown staff member or no PIN set') };
        }
        if (this.isLocked(credential, now)) {
          return { error: await this.lockedFailure(base, credential.lockedUntil ?? now) };
        }
        if (!(await this.hasher.verify(credential.secretHash, request.pin))) {
          return { error: await this.wrongSecret(base, credential, settings, now, 'Wrong PIN') };
        }
        if (staff.role === 'KITCHEN' && !settings.kitchenIndividualLogins) {
          return { error: authErrors.kitchenStationMode() };
        }
        await this.clearFailures(tx, credential.id);
        const session = await this.sessions.create(tx, {
          staffId: staff.id,
          device,
          settings,
          secondFactorAt: null,
          now,
        });
        await this.audit.record(tx, {
          action: 'LOGIN',
          entityType: 'session',
          entityId: session.session.id,
          actorId: staff.id,
          deviceId: device.deviceId,
          restaurantId: device.restaurantId,
          after: { method: 'PIN', role: staff.role },
        });
        return { ok: { staff, session } };
      },
    );
    if ('error' in outcome) throw outcome.error;
    return this.sessions.issue({
      ...outcome.ok.session,
      staff: outcome.ok.staff,
      device,
      settings,
      now,
    });
  }

  /** Owner sign-in with password and TOTP (or a recovery code); includes a fresh step-up. */
  async ownerLogin(
    device: AuthenticatedDevice,
    request: OwnerLoginRequest,
  ): Promise<LoginResponse> {
    const settings = await this.settings.get(device.restaurantId);
    this.throttle(`login:${device.deviceId}`, settings);
    const now = new Date();

    const outcome = await this.prisma.transaction(async (tx) => {
      const staff = await this.activeStaff(tx, device.restaurantId, request.staffId);
      const base = { tx, device, staffId: request.staffId, method: 'OWNER_PASSWORD' as const };
      if (staff?.role !== 'OWNER') {
        await this.hasher.verifyNothing(request.password);
        return { error: await this.failure(base, 'Not an owner account') } as const;
      }
      const verified = await this.verifyOwnerSecrets(tx, base, staff.id, request, settings, now);
      if ('error' in verified) return verified;
      const session = await this.sessions.create(tx, {
        staffId: staff.id,
        device,
        settings,
        secondFactorAt: now,
        now,
      });
      await this.audit.record(tx, {
        action: 'LOGIN',
        entityType: 'session',
        entityId: session.session.id,
        actorId: staff.id,
        deviceId: device.deviceId,
        restaurantId: device.restaurantId,
        after: { method: 'OWNER_PASSWORD', secondFactor: request.secondFactor.kind },
      });
      return { ok: { staff, session } } as const;
    });
    if ('error' in outcome) throw outcome.error;
    return this.sessions.issue({
      ...outcome.ok.session,
      staff: outcome.ok.staff,
      device,
      settings,
      now,
    });
  }

  /** Confirms the Owner's password and second factor for Owner-only actions (AUTH-006). */
  async stepUp(
    principal: Principal,
    device: AuthenticatedDevice,
    request: StepUpRequest,
  ): Promise<StepUpResponse> {
    if (principal.role !== 'OWNER') throw authErrors.ownerOnly();
    const settings = await this.settings.get(principal.restaurantId);
    this.throttle(`login:${device.deviceId}`, settings);
    const now = new Date();
    const outcome = await this.prisma.transaction(async (tx) => {
      const base = { tx, device, staffId: principal.staffId, method: 'STEP_UP' as const };
      const verified = await this.verifyOwnerSecrets(
        tx,
        base,
        principal.staffId,
        request,
        settings,
        now,
      );
      if ('error' in verified) return verified;
      await tx.session.update({
        where: { id: principal.sessionId },
        data: { secondFactorAt: now },
      });
      await this.audit.record(tx, {
        action: 'STEP_UP',
        entityType: 'session',
        entityId: principal.sessionId,
        actorId: principal.staffId,
        deviceId: device.deviceId,
        restaurantId: principal.restaurantId,
        after: { secondFactor: request.secondFactor.kind },
      });
      return { ok: true } as const;
    });
    if ('error' in outcome) throw outcome.error;
    return {
      secondFactorValidUntil: new Date(
        now.getTime() + settings.stepUpMinutes * 60_000,
      ).toISOString(),
    };
  }

  async logout(principal: Principal): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      await this.sessions.revoke(principal.sessionId, 'LOGOUT', tx);
      await this.audit.record(tx, {
        action: 'LOGOUT',
        entityType: 'session',
        entityId: principal.sessionId,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
      });
    });
  }

  /** A manager lifts a lockout before it expires (AUTH-003). */
  async unlock(principal: Principal, staffId: string): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      const staff = await tx.staff.findFirst({
        where: { id: staffId, restaurantId: principal.restaurantId },
        select: { id: true },
      });
      if (staff === null) throw authErrors.forbidden();
      const before = await tx.credential.findMany({
        where: { staffId },
        select: { kind: true, lockedUntil: true, failedAttempts: true },
      });
      await tx.credential.updateMany({
        where: { staffId },
        data: { failedAttempts: 0, failureWindowStartedAt: null, lockedUntil: null },
      });
      await this.audit.record(tx, {
        action: 'STAFF_UNLOCKED',
        entityType: 'staff',
        entityId: staffId,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        before: before.map((credential) => ({
          kind: credential.kind,
          lockedUntil: credential.lockedUntil,
          failedAttempts: credential.failedAttempts,
        })),
      });
    });
  }

  /**
   * A manager approves one action of the signed-in requester on this device with their PIN
   * (AUTH-011). Returns a single-use, short-lived token for that capability (and entity).
   */
  async grantOverride(
    principal: Principal,
    device: AuthenticatedDevice,
    request: OverrideRequest,
  ): Promise<OverrideResponse> {
    const grant = grantFor(principal.role, request.capability);
    if (grant === 'DENY') throw authErrors.forbidden();
    if (grant !== 'OVERRIDE') throw authErrors.overrideNotNeeded();
    const settings = await this.settings.get(principal.restaurantId);
    this.throttle(`override:${device.deviceId}`, settings);
    const now = new Date();

    const outcome = await this.prisma.transaction(async (tx): Promise<Outcome<GrantedOverride>> => {
      const approver = await this.activeStaff(tx, principal.restaurantId, request.approverStaffId);
      const base = {
        tx,
        device,
        staffId: request.approverStaffId,
        method: 'OVERRIDE' as const,
        requesterId: principal.staffId,
        capability: request.capability,
      };
      if (
        approver === null ||
        !canApproveOverride(approver.role) ||
        approver.id === principal.staffId
      ) {
        await this.hasher.verifyNothing(request.pin);
        await this.failure(base, 'Approver is not an active manager or owner');
        return { error: authErrors.approverNotAllowed() };
      }
      const credential = await this.lockedCredential(tx, approver.id, 'PIN');
      if (credential === null) {
        await this.hasher.verifyNothing(request.pin);
        return { error: await this.failure(base, 'Approver has no PIN') };
      }
      if (this.isLocked(credential, now)) {
        return { error: await this.lockedFailure(base, credential.lockedUntil ?? now) };
      }
      if (!(await this.hasher.verify(credential.secretHash, request.pin))) {
        return {
          error: await this.wrongSecret(base, credential, settings, now, 'Wrong approver PIN'),
        };
      }
      await this.clearFailures(tx, credential.id);
      const token = randomToken();
      const expiresAt = new Date(now.getTime() + settings.overrideSeconds * 1000);
      const created = await tx.overrideGrant.create({
        data: {
          restaurantId: principal.restaurantId,
          deviceId: device.deviceId,
          requesterId: principal.staffId,
          requesterSessionId: principal.sessionId,
          approverId: approver.id,
          capability: request.capability,
          entityType: request.entityType ?? null,
          entityId: request.entityId ?? null,
          tokenHash: sha256Hex(token),
          expiresAt,
        },
      });
      await this.audit.record(tx, {
        action: 'OVERRIDE_GRANTED',
        entityType: request.entityType ?? 'override_grant',
        entityId: request.entityId ?? created.id,
        actorId: principal.staffId,
        approverId: approver.id,
        deviceId: device.deviceId,
        restaurantId: principal.restaurantId,
        after: { capability: request.capability, grantId: created.id, expiresAt },
      });
      return { ok: { token, expiresAt, approver } };
    });
    if ('error' in outcome) throw outcome.error;
    const { token, expiresAt, approver } = outcome.ok;
    return {
      overrideToken: token,
      expiresAt: expiresAt.toISOString(),
      approver: { id: approver.id, displayName: approver.displayName, role: approver.role },
    };
  }

  /**
   * Uses up an override token for `capability`, if it was issued to this person's session on this
   * device, is unused and has not expired. Single use: a second request with it is refused.
   */
  async consumeOverride(
    principal: Principal,
    capability: string,
    token: string,
  ): Promise<ConsumedOverride | null> {
    const now = new Date();
    const tokenHash = sha256Hex(token);
    const used = await this.prisma.overrideGrant.updateMany({
      where: {
        tokenHash,
        usedAt: null,
        expiresAt: { gt: now },
        capability,
        requesterSessionId: principal.sessionId,
        deviceId: principal.deviceId,
      },
      data: { usedAt: now },
    });
    if (used.count !== 1) return null;
    const grant = await this.prisma.overrideGrant.findUniqueOrThrow({ where: { tokenHash } });
    return { approverId: grant.approverId, entityType: grant.entityType, entityId: grant.entityId };
  }

  /** Starts (or restarts) authenticator setup for the Owner (AUTH-006). */
  async enrollTotp(principal: Principal, settings?: AuthSettings): Promise<TotpEnrollmentResponse> {
    if (principal.role !== 'OWNER') throw authErrors.ownerOnly();
    const resolved = settings ?? (await this.settings.get(principal.restaurantId));
    const existing = await this.prisma.credential.findUnique({
      where: { staffId_kind: { staffId: principal.staffId, kind: 'TOTP' } },
    });
    if (existing !== null && existing.confirmedAt !== null) {
      this.requireFreshStepUp(principal, resolved);
    }
    const secret = generateTotpSecret();
    const sealed = seal(await this.secrets.get('totp-encryption-key'), secret);
    const [staff, restaurant] = await Promise.all([
      this.prisma.staff.findUniqueOrThrow({ where: { id: principal.staffId } }),
      this.prisma.restaurant.findUniqueOrThrow({ where: { id: principal.restaurantId } }),
    ]);
    await this.prisma.transaction(async (tx) => {
      await tx.credential.upsert({
        where: { staffId_kind: { staffId: principal.staffId, kind: 'TOTP' } },
        create: {
          restaurantId: principal.restaurantId,
          staffId: principal.staffId,
          kind: 'TOTP',
          secretHash: '',
          pendingSecret: sealed,
        },
        update: { pendingSecret: sealed },
      });
      await this.audit.record(tx, {
        action: 'TOTP_ENROLMENT_STARTED',
        entityType: 'staff',
        entityId: principal.staffId,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
      });
    });
    return {
      secret: base32Encode(secret),
      otpauthUri: otpauthUri(restaurant.displayName, staff.displayName, secret),
    };
  }

  /** Confirms setup with a first code and returns ten one-time recovery codes. */
  async confirmTotp(principal: Principal, code: string): Promise<TotpConfirmResponse> {
    if (principal.role !== 'OWNER') throw authErrors.ownerOnly();
    const now = new Date();
    const key = await this.secrets.get('totp-encryption-key');
    return this.prisma.transaction(async (tx) => {
      const credential = await tx.credential.findUnique({
        where: { staffId_kind: { staffId: principal.staffId, kind: 'TOTP' } },
      });
      const pendingSecret = credential?.pendingSecret ?? null;
      if (credential === null || pendingSecret === null) throw authErrors.totpNotStarted();
      const step = verifyTotp(open(key, pendingSecret), code, now, null);
      if (step === null) throw authErrors.invalidCode();
      await tx.credential.update({
        where: { id: credential.id },
        data: {
          secretHash: pendingSecret,
          pendingSecret: null,
          confirmedAt: now,
          lastTotpStep: BigInt(step),
          rotatedAt: now,
        },
      });
      const codes = Array.from({ length: RECOVERY_CODES }, recoveryCode);
      await tx.recoveryCode.deleteMany({ where: { staffId: principal.staffId } });
      await tx.recoveryCode.createMany({
        data: codes.map((value) => ({
          restaurantId: principal.restaurantId,
          staffId: principal.staffId,
          codeHash: sha256Hex(value),
        })),
      });
      await this.audit.record(tx, {
        action: 'TOTP_ENROLLED',
        entityType: 'staff',
        entityId: principal.staffId,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        after: { recoveryCodes: RECOVERY_CODES },
      });
      return { recoveryCodes: codes };
    });
  }

  /**
   * Sets the Owner password (first setup) or changes it (needs the current password and a fresh
   * step-up). A change signs the Owner out everywhere else.
   */
  async setOwnerPassword(principal: Principal, request: OwnerPasswordRequest): Promise<void> {
    if (principal.role !== 'OWNER') throw authErrors.ownerOnly();
    const settings = await this.settings.get(principal.restaurantId);
    const existing = await this.prisma.credential.findUnique({
      where: { staffId_kind: { staffId: principal.staffId, kind: 'PASSWORD' } },
    });
    if (existing !== null) {
      this.requireFreshStepUp(principal, settings);
      if (request.currentPassword === undefined) throw authErrors.currentPasswordRequired();
      if (!(await this.hasher.verify(existing.secretHash, request.currentPassword))) {
        throw authErrors.invalidCredentials();
      }
    }
    const secretHash = await this.hasher.hash(request.newPassword);
    await this.prisma.transaction(async (tx) => {
      await tx.credential.upsert({
        where: { staffId_kind: { staffId: principal.staffId, kind: 'PASSWORD' } },
        create: {
          restaurantId: principal.restaurantId,
          staffId: principal.staffId,
          kind: 'PASSWORD',
          secretHash,
        },
        update: { secretHash, rotatedAt: new Date(), failedAttempts: 0, lockedUntil: null },
      });
      if (existing !== null) {
        await tx.session.updateMany({
          where: { staffId: principal.staffId, revokedAt: null, id: { not: principal.sessionId } },
          data: { revokedAt: new Date(), revokeReason: 'PASSWORD_CHANGED' },
        });
      }
      await this.audit.record(tx, {
        action: existing === null ? 'OWNER_PASSWORD_SET' : 'OWNER_PASSWORD_CHANGED',
        entityType: 'staff',
        entityId: principal.staffId,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
      });
    });
  }

  /** The Owner confirmed password + second factor recently enough (AUTH-006). */
  hasFreshStepUp(principal: Principal, settings: AuthSettings, now: Date = new Date()): boolean {
    return (
      principal.role === 'OWNER' &&
      principal.secondFactorAt !== null &&
      now.getTime() - principal.secondFactorAt.getTime() <= settings.stepUpMinutes * 60_000
    );
  }

  private requireFreshStepUp(principal: Principal, settings: AuthSettings): void {
    if (!this.hasFreshStepUp(principal, settings)) throw authErrors.secondFactorRequired();
  }

  private throttle(key: string, settings: AuthSettings): void {
    if (!this.limiter.attempt(key, settings.attemptsPerMinutePerDevice, 60_000)) {
      throw authErrors.rateLimited();
    }
  }

  private async activeStaff(
    tx: TransactionClient,
    restaurantId: string,
    staffId: string,
  ): Promise<(SessionStaff & { readonly role: Role }) | null> {
    const staff = await tx.staff.findFirst({
      where: { id: staffId, restaurantId, active: true, archivedAt: null },
      include: { role: true },
    });
    return staff === null
      ? null
      : { id: staff.id, displayName: staff.displayName, role: staff.role.baseRole };
  }

  /** Reads a credential with a row lock, so concurrent attempts count one after another. */
  private async lockedCredential(
    tx: TransactionClient,
    staffId: string,
    kind: CredentialKind,
  ): Promise<CredentialRow | null> {
    await tx.$queryRaw`SELECT 1 AS locked FROM credentials
      WHERE staff_id = ${staffId}::uuid AND kind = ${kind}::"CredentialKind" FOR UPDATE`;
    return tx.credential.findUnique({ where: { staffId_kind: { staffId, kind } } });
  }

  private isLocked(credential: CredentialRow, now: Date): boolean {
    return credential.lockedUntil !== null && credential.lockedUntil > now;
  }

  private async clearFailures(tx: TransactionClient, credentialId: string): Promise<void> {
    await tx.credential.update({
      where: { id: credentialId },
      data: { failedAttempts: 0, failureWindowStartedAt: null, lockedUntil: null },
    });
  }

  /** Password + second factor of the Owner; failures count against the password credential. */
  private async verifyOwnerSecrets(
    tx: TransactionClient,
    base: FailureContext,
    staffId: string,
    request: { password: string; secondFactor: SecondFactor },
    settings: AuthSettings,
    now: Date,
  ): Promise<Outcome<true>> {
    const credential = await this.lockedCredential(tx, staffId, 'PASSWORD');
    if (credential === null) {
      await this.hasher.verifyNothing(request.password);
      return { error: await this.failure(base, 'No owner password set') };
    }
    if (this.isLocked(credential, now)) {
      return { error: await this.lockedFailure(base, credential.lockedUntil ?? now) };
    }
    const passwordOk = await this.hasher.verify(credential.secretHash, request.password);
    // The second factor is only checked (and a recovery code only used up) after the password.
    const factorOk =
      passwordOk && (await this.verifySecondFactor(tx, staffId, request.secondFactor, now));
    if (!factorOk) {
      const reason = passwordOk ? 'Wrong second factor' : 'Wrong password';
      return { error: await this.wrongSecret(base, credential, settings, now, reason) };
    }
    await this.clearFailures(tx, credential.id);
    return { ok: true };
  }

  private async verifySecondFactor(
    tx: TransactionClient,
    staffId: string,
    factor: SecondFactor,
    now: Date,
  ): Promise<boolean> {
    if (factor.kind === 'RECOVERY_CODE') {
      const used = await tx.recoveryCode.updateMany({
        where: { staffId, codeHash: sha256Hex(factor.code), usedAt: null },
        data: { usedAt: now },
      });
      return used.count === 1;
    }
    const credential = await this.lockedCredential(tx, staffId, 'TOTP');
    if (credential === null) return false;
    const totp = await tx.credential.findUniqueOrThrow({ where: { id: credential.id } });
    if (totp.confirmedAt === null || totp.secretHash === '') return false;
    const secret = open(await this.secrets.get('totp-encryption-key'), totp.secretHash);
    const lastStep = totp.lastTotpStep === null ? null : Number(totp.lastTotpStep);
    const step = verifyTotp(secret, factor.code, now, lastStep);
    if (step === null) return false;
    await tx.credential.update({ where: { id: totp.id }, data: { lastTotpStep: BigInt(step) } });
    return true;
  }

  /** Counts a wrong PIN/password in the lockout window, locking at the limit (AUTH-003). */
  private async wrongSecret(
    context: FailureContext,
    credential: CredentialRow,
    settings: AuthSettings,
    now: Date,
    reason: string,
  ): Promise<AppError> {
    const windowMs = settings.lockoutWindowMinutes * 60_000;
    const inWindow =
      credential.failureWindowStartedAt !== null &&
      now.getTime() - credential.failureWindowStartedAt.getTime() < windowMs;
    const failures = inWindow ? credential.failedAttempts + 1 : 1;
    const lock = failures >= settings.lockoutMaxFailures;
    const lockedUntil = new Date(now.getTime() + settings.lockoutMinutes * 60_000);
    await context.tx.credential.update({
      where: { id: credential.id },
      data: lock
        ? { failedAttempts: 0, failureWindowStartedAt: null, lockedUntil }
        : {
            failedAttempts: failures,
            failureWindowStartedAt: inWindow ? credential.failureWindowStartedAt : now,
          },
    });
    await this.failure(context, reason, { failures });
    if (!lock) return authErrors.invalidCredentials(settings.lockoutMaxFailures - failures);
    await this.audit.record(context.tx, {
      action: 'LOGIN_LOCKED',
      entityType: 'staff',
      entityId: context.staffId,
      deviceId: context.device.deviceId,
      restaurantId: context.device.restaurantId,
      after: { lockedUntil, method: context.method },
      reason: `${String(settings.lockoutMaxFailures)} failed attempts within ${String(settings.lockoutWindowMinutes)} minutes`,
    });
    return authErrors.locked(lockedUntil);
  }

  private async lockedFailure(context: FailureContext, lockedUntil: Date): Promise<AppError> {
    await this.failure(context, 'Login is locked');
    return authErrors.locked(lockedUntil);
  }

  /** Audits a failed attempt (AUTH-013) and returns the generic credential error. */
  private async failure(
    context: FailureContext,
    reason: string,
    extra: Record<string, unknown> = {},
  ): Promise<AppError> {
    const override = context.method === 'OVERRIDE';
    await this.audit.record(context.tx, {
      action: override ? 'OVERRIDE_DENIED' : 'LOGIN_FAILED',
      entityType: 'staff',
      entityId: context.staffId,
      actorId: override ? (context.requesterId ?? null) : null,
      approverId: null,
      deviceId: context.device.deviceId,
      restaurantId: context.device.restaurantId,
      after: {
        method: context.method,
        ...(override && { capability: context.capability }),
        ...extra,
      },
      reason,
    });
    return authErrors.invalidCredentials();
  }
}

interface GrantedOverride {
  readonly token: string;
  readonly expiresAt: Date;
  readonly approver: SessionStaff;
}

interface FailureContext {
  readonly tx: TransactionClient;
  readonly device: AuthenticatedDevice;
  /** The person whose credential was tried (the approver, for overrides). */
  readonly staffId: string;
  readonly method: 'PIN' | 'OWNER_PASSWORD' | 'STEP_UP' | 'OVERRIDE';
  readonly requesterId?: string;
  readonly capability?: string;
}
