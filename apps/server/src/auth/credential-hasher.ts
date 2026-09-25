import { hash, verify } from '@node-rs/argon2';
import { Inject, Injectable } from '@nestjs/common';
import { SECRET_STORE, type SecretStore } from './secret-store.js';

/**
 * Argon2id hashing of PINs and passwords with the server-side pepper (AUTH-002, AUTH-006).
 *
 * The pepper is Argon2's secret input and is kept outside the database (SecretStore; DPAPI on the
 * restaurant PC), so a stolen database alone cannot be brute-forced even for 4-digit PINs.
 * Parameters follow the OWASP recommendation for Argon2id (19 MiB, 2 passes, 1 lane).
 */
@Injectable()
export class CredentialHasher {
  private dummyHash: Promise<string> | undefined;

  constructor(@Inject(SECRET_STORE) private readonly secrets: SecretStore) {}

  async hash(secret: string): Promise<string> {
    // Argon2id is the library default (tests check the `$argon2id$` prefix).
    return hash(secret, {
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      secret: await this.secrets.get('pin-pepper'),
    });
  }

  /** True when `secret` matches `encoded`; false for a mismatch or a malformed hash. */
  async verify(encoded: string, secret: string): Promise<boolean> {
    try {
      return await verify(encoded, secret, { secret: await this.secrets.get('pin-pepper') });
    } catch {
      return false;
    }
  }

  /**
   * Spends the same time as a real check when there is nothing to check (unknown staff member or
   * no credential), so response times do not reveal which it was.
   */
  async verifyNothing(secret: string): Promise<false> {
    this.dummyHash ??= this.hash('not-a-real-credential');
    await this.verify(await this.dummyHash, secret);
    return false;
  }
}
