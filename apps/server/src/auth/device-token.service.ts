import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { errors, jwtVerify, SignJWT } from 'jose';
import { SECRET_STORE, type SecretStore } from './secret-store.js';

const ISSUER = 'rp-local-server';
const AUDIENCE = 'rp-device';
const CHALLENGE_TTL_MS = 60_000;
const MAX_OPEN_CHALLENGES = 10_000;

export interface DeviceTokenClaims {
  readonly deviceId: string;
  readonly restaurantId: string;
}

/**
 * Device tokens (AUTH-007): a device signs a one-time server challenge with its key and receives a
 * short-lived token (JWT, HS256, its own key) that it sends with every request. Challenges live in
 * memory for 60 seconds; the local server is a single process.
 */
@Injectable()
export class DeviceTokenService {
  private readonly challenges = new Map<string, { deviceId: string; expiresAt: number }>();

  constructor(@Inject(SECRET_STORE) private readonly secrets: SecretStore) {}

  createChallenge(
    deviceId: string,
    now: number = Date.now(),
  ): { challenge: string; expiresAt: Date } {
    if (this.challenges.size >= MAX_OPEN_CHALLENGES) this.prune(now);
    const challenge = randomBytes(32).toString('base64url');
    const expiresAt = now + CHALLENGE_TTL_MS;
    this.challenges.set(challenge, { deviceId, expiresAt });
    return { challenge, expiresAt: new Date(expiresAt) };
  }

  /** Uses up a challenge; true when it was issued to `deviceId` and has not expired. */
  consumeChallenge(challenge: string, deviceId: string, now: number = Date.now()): boolean {
    const entry = this.challenges.get(challenge);
    this.challenges.delete(challenge);
    return entry?.deviceId === deviceId && entry.expiresAt > now;
  }

  async sign(
    claims: DeviceTokenClaims,
    ttlSeconds: number,
    now: Date = new Date(),
  ): Promise<{ token: string; expiresAt: Date }> {
    const issuedAt = Math.floor(now.getTime() / 1000);
    const token = await new SignJWT({ rid: claims.restaurantId, typ: 'device' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.deviceId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ttlSeconds)
      .sign(await this.secrets.get('device-token-key'));
    return { token, expiresAt: new Date((issuedAt + ttlSeconds) * 1000) };
  }

  /** The claims of a valid, unexpired device token; undefined otherwise. */
  async verify(token: string): Promise<DeviceTokenClaims | undefined> {
    try {
      const { payload } = await jwtVerify(token, await this.secrets.get('device-token-key'), {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      const { sub, rid, typ } = payload;
      if (typeof sub !== 'string' || typeof rid !== 'string' || typ !== 'device') return undefined;
      return { deviceId: sub, restaurantId: rid };
    } catch (error) {
      if (error instanceof errors.JOSEError) return undefined;
      throw error;
    }
  }

  private prune(now: number): void {
    for (const [challenge, entry] of this.challenges) {
      if (entry.expiresAt <= now) this.challenges.delete(challenge);
    }
  }
}
