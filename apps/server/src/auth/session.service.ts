import { Injectable } from '@nestjs/common';
import type { LoginResponse } from '@rp/contracts';
import type { Role } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import type { AppError } from '../errors/app-error.js';
import { authErrors } from './auth-errors.js';
import { type AuthSettings, AuthSettingsService } from './auth-settings.js';
import type { AuthenticatedDevice } from './device.js';
import type { Principal } from './principal.js';
import { AccessTokenError, randomToken, sha256Hex, TokenService } from './tokens.js';

/** Writes of `lastActiveAt` are skipped within this interval to save a write per request. */
const TOUCH_INTERVAL_MS = 30_000;

export interface SessionStaff {
  readonly id: string;
  readonly displayName: string;
  readonly role: Role;
}

interface SessionRow {
  readonly id: string;
  readonly restaurantId: string;
  readonly expiresAt: Date;
  readonly secondFactorAt: Date | null;
}

export type AccessResult = { readonly principal: Principal } | { readonly failure: AppError };

/**
 * Staff sessions on a device (AUTH-005): a refresh token (stored hashed, rotated on every use), a
 * short-lived access token, an absolute lifetime and an inactivity timeout renewed by activity.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly settings: AuthSettingsService,
    private readonly audit: AuditService,
  ) {}

  inactivityMs(settings: AuthSettings, device: AuthenticatedDevice): number {
    const minutes =
      device.type === 'MANAGER_BROWSER'
        ? settings.managerBrowserInactivityMinutes
        : settings.inactivityMinutes;
    return minutes * 60_000;
  }

  /** Starts a session inside the caller's transaction and returns its refresh token. */
  async create(
    tx: TransactionClient,
    input: {
      staffId: string;
      device: AuthenticatedDevice;
      settings: AuthSettings;
      secondFactorAt: Date | null;
      now: Date;
    },
  ): Promise<{ session: SessionRow; refreshToken: string }> {
    const refreshToken = randomToken();
    const session = await tx.session.create({
      data: {
        restaurantId: input.device.restaurantId,
        staffId: input.staffId,
        deviceId: input.device.deviceId,
        tokenHash: sha256Hex(refreshToken),
        expiresAt: new Date(input.now.getTime() + input.settings.sessionMaxHours * 3_600_000),
        lastActiveAt: input.now,
        secondFactorAt: input.secondFactorAt,
      },
      select: { id: true, restaurantId: true, expiresAt: true, secondFactorAt: true },
    });
    return { session, refreshToken };
  }

  /** The tokens and session facts a client receives after sign-in or refresh. */
  async issue(input: {
    session: SessionRow;
    refreshToken: string;
    staff: SessionStaff;
    device: AuthenticatedDevice;
    settings: AuthSettings;
    now: Date;
  }): Promise<LoginResponse> {
    const { session, settings, now } = input;
    const ttlSeconds = Math.max(
      1,
      Math.min(
        settings.accessTokenMinutes * 60,
        Math.floor((session.expiresAt.getTime() - now.getTime()) / 1000),
      ),
    );
    const access = await this.tokens.signAccessToken(
      {
        staffId: input.staff.id,
        role: input.staff.role,
        restaurantId: session.restaurantId,
        deviceId: input.device.deviceId,
        sessionId: session.id,
      },
      ttlSeconds,
      now,
    );
    const stepUpUntil =
      session.secondFactorAt === null
        ? null
        : new Date(session.secondFactorAt.getTime() + settings.stepUpMinutes * 60_000);
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: input.refreshToken,
      session: {
        id: session.id,
        expiresAt: session.expiresAt.toISOString(),
        inactivityTimeoutSeconds: this.inactivityMs(settings, input.device) / 1000,
      },
      staff: { id: input.staff.id, displayName: input.staff.displayName, role: input.staff.role },
      secondFactorValidUntil:
        stepUpUntil !== null && stepUpUntil > now ? stepUpUntil.toISOString() : null,
    };
  }

  /**
   * Checks an access token on every request: signature and expiry, the device it was issued to,
   * and the session behind it (not revoked, not expired, not idle, person still active). Renews
   * the inactivity timer.
   */
  async authenticate(
    token: string,
    device: AuthenticatedDevice | undefined,
  ): Promise<AccessResult> {
    let claims;
    try {
      claims = await this.tokens.verifyAccessToken(token);
    } catch (error) {
      const expired = error instanceof AccessTokenError && error.reason === 'TOKEN_EXPIRED';
      return { failure: expired ? authErrors.tokenExpired() : authErrors.tokenInvalid() };
    }
    if (device?.deviceId !== claims.deviceId) return { failure: authErrors.deviceMismatch() };

    const now = new Date();
    const session = await this.prisma.session.findUnique({
      where: { id: claims.sessionId },
      include: { staff: { include: { role: true } } },
    });
    if (session === null) return { failure: authErrors.sessionRevoked() };
    if (session.revokedAt !== null || session.deviceId !== device.deviceId) {
      return { failure: authErrors.sessionRevoked() };
    }
    const settings = await this.settings.get(session.restaurantId);
    const idleFor = now.getTime() - session.lastActiveAt.getTime();
    if (session.expiresAt <= now || idleFor > this.inactivityMs(settings, device)) {
      await this.revoke(session.id, session.expiresAt <= now ? 'EXPIRED' : 'INACTIVITY');
      return { failure: authErrors.sessionExpired() };
    }
    if (!session.staff.active || session.staff.archivedAt !== null) {
      await this.revoke(session.id, 'STAFF_DEACTIVATED');
      return { failure: authErrors.sessionRevoked() };
    }
    if (idleFor > TOUCH_INTERVAL_MS) {
      await this.prisma.session.update({ where: { id: session.id }, data: { lastActiveAt: now } });
    }
    return {
      principal: {
        staffId: session.staffId,
        // The current role applies at once, even if it changed since the token was issued.
        role: session.staff.role.baseRole,
        restaurantId: session.restaurantId,
        deviceId: session.deviceId,
        sessionId: session.id,
        secondFactorAt: session.secondFactorAt,
      },
    };
  }

  /**
   * Rotates the refresh token and issues a new access token. Presenting an already rotated
   * refresh token means it leaked: the whole session is revoked (AUTH-005).
   */
  async refresh(refreshToken: string, device: AuthenticatedDevice): Promise<LoginResponse> {
    const now = new Date();
    const hash = sha256Hex(refreshToken);
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hash },
      include: { staff: { include: { role: true } } },
    });
    if (session === null) {
      const reused = await this.prisma.session.findUnique({ where: { previousTokenHash: hash } });
      if (reused !== null && reused.revokedAt === null) {
        await this.prisma.transaction(async (tx) => {
          await tx.session.update({
            where: { id: reused.id },
            data: { revokedAt: now, revokeReason: 'REFRESH_TOKEN_REUSED' },
          });
          await this.audit.record(tx, {
            action: 'REFRESH_TOKEN_REUSED',
            entityType: 'session',
            entityId: reused.id,
            actorId: reused.staffId,
            deviceId: device.deviceId,
            restaurantId: reused.restaurantId,
            reason: 'A replaced refresh token was presented again; the session was revoked.',
          });
        });
      }
      throw authErrors.sessionRevoked();
    }
    if (session.deviceId !== device.deviceId) throw authErrors.deviceMismatch();
    if (session.revokedAt !== null) throw authErrors.sessionRevoked();
    const settings = await this.settings.get(session.restaurantId);
    const idleFor = now.getTime() - session.lastActiveAt.getTime();
    if (session.expiresAt <= now || idleFor > this.inactivityMs(settings, device)) {
      await this.revoke(session.id, session.expiresAt <= now ? 'EXPIRED' : 'INACTIVITY');
      throw authErrors.sessionExpired();
    }
    if (!session.staff.active || session.staff.archivedAt !== null) {
      await this.revoke(session.id, 'STAFF_DEACTIVATED');
      throw authErrors.sessionRevoked();
    }

    const nextToken = randomToken();
    // Conditional on the old hash, so two concurrent refreshes cannot both succeed.
    const rotated = await this.prisma.session.updateMany({
      where: { id: session.id, tokenHash: hash, revokedAt: null },
      data: { tokenHash: sha256Hex(nextToken), previousTokenHash: hash, lastActiveAt: now },
    });
    if (rotated.count !== 1) throw authErrors.sessionRevoked();
    return this.issue({
      session,
      refreshToken: nextToken,
      staff: {
        id: session.staffId,
        displayName: session.staff.displayName,
        role: session.staff.role.baseRole,
      },
      device,
      settings,
      now,
    });
  }

  async revoke(
    sessionId: string,
    reason: string,
    tx: TransactionClient = this.prisma,
  ): Promise<void> {
    await tx.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  }
}
