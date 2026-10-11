import { Inject, Injectable } from '@nestjs/common';
import type { LicencePayload, SignedLicence } from '@rp/contracts/control-plane';
import { signLicence } from '@rp/licensing';
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { CP_CONFIG, type CpConfig } from '../config/cp-config.js';

/**
 * Signs licence files (LIC-001) with the vendor's Ed25519 key. In development and tests the key
 * comes from configuration (`CP_LICENCE_SIGNING_KEY`); production keeps it in the cloud KMS and
 * this class is where a KMS adapter replaces the key in memory (manual task 23).
 */
@Injectable()
export class LicenceSigner {
  private readonly key: { privateKey: KeyObject; publicSpki: string } | undefined;

  constructor(@Inject(CP_CONFIG) config: CpConfig) {
    if (config.licenceSigningKey === undefined) return;
    const privateKey = createPrivateKey({
      key: Buffer.from(config.licenceSigningKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('CP_LICENCE_SIGNING_KEY is not an Ed25519 key');
    }
    const publicSpki = createPublicKey(privateKey)
      .export({ format: 'der', type: 'spki' })
      .toString('base64');
    this.key = { privateKey, publicSpki };
  }

  /** Whether licences can be issued at all. */
  get ready(): boolean {
    return this.key !== undefined;
  }

  /** The public key installations must hold to accept these licences (SPKI DER, base64). */
  get publicKey(): string | undefined {
    return this.key?.publicSpki;
  }

  sign(payload: LicencePayload): SignedLicence {
    if (this.key === undefined) throw new Error('No licence-signing key is configured');
    return signLicence(payload, this.key.privateKey, this.key.publicSpki);
  }
}
