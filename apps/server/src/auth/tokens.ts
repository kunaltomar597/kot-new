import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ROLES, type Role } from '@rp/domain';
import { errors, jwtVerify, SignJWT } from 'jose';
import { SECRET_STORE, type SecretStore } from './secret-store.js';

const ISSUER = 'rp-local-server';
const AUDIENCE = 'rp-local';

/** What an access token asserts (AUTH-005): person, role, restaurant, device and session. */
export interface AccessClaims {
  readonly staffId: string;
  readonly role: Role;
  readonly restaurantId: string;
  readonly deviceId: string;
  readonly sessionId: string;
}

export type AccessTokenFailure = 'TOKEN_EXPIRED' | 'TOKEN_INVALID';

export class AccessTokenError extends Error {
  constructor(readonly reason: AccessTokenFailure) {
    super(reason === 'TOKEN_EXPIRED' ? 'Access token expired' : 'Access token invalid');
    this.name = 'AccessTokenError';
  }
}

/** A random opaque token (refresh and override tokens), 256 bits, base64url. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex; stored instead of opaque tokens and recovery codes, which are high-entropy. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Signs and verifies short-lived access tokens (JWT, HS256) with the key from the SecretStore.
 * Tokens are only ever accepted together with the device they were issued to.
 */
@Injectable()
export class TokenService {
  constructor(@Inject(SECRET_STORE) private readonly secrets: SecretStore) {}

  async signAccessToken(
    claims: AccessClaims,
    ttlSeconds: number,
    now: Date = new Date(),
  ): Promise<{ token: string; expiresAt: Date }> {
    const issuedAt = Math.floor(now.getTime() / 1000);
    const expiresAt = new Date((issuedAt + ttlSeconds) * 1000);
    const token = await new SignJWT({
      role: claims.role,
      rid: claims.restaurantId,
      did: claims.deviceId,
      sid: claims.sessionId,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.staffId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ttlSeconds)
      .sign(await this.secrets.get('token-signing-key'));
    return { token, expiresAt };
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, await this.secrets.get('token-signing-key'), {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      const { sub, role, rid, did, sid } = payload;
      if (
        typeof sub !== 'string' ||
        typeof role !== 'string' ||
        !(ROLES as readonly string[]).includes(role) ||
        typeof rid !== 'string' ||
        typeof did !== 'string' ||
        typeof sid !== 'string'
      ) {
        throw new AccessTokenError('TOKEN_INVALID');
      }
      return { staffId: sub, role: role as Role, restaurantId: rid, deviceId: did, sessionId: sid };
    } catch (error) {
      if (error instanceof AccessTokenError) throw error;
      if (error instanceof errors.JWTExpired) throw new AccessTokenError('TOKEN_EXPIRED');
      throw new AccessTokenError('TOKEN_INVALID');
    }
  }
}
