import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';
import {
  type EnrolRequest,
  enrolmentProofMessage,
  INSTALLATION_HEADERS,
  signedRequestMessage,
} from '@rp/contracts/control-plane';

/** A restaurant PC as the Control Plane sees it: an Ed25519 key that signs its requests. */
export class TestInstallation {
  id: string | undefined;

  private constructor(
    readonly privateKey: KeyObject,
    readonly publicKeyBase64: string,
  ) {}

  static create(): TestInstallation {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return new TestInstallation(
      privateKey,
      publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    );
  }

  enrolRequest(code: string, proofKey: KeyObject = this.privateKey): EnrolRequest {
    return {
      code,
      publicKey: this.publicKeyBase64,
      proof: sign(null, Buffer.from(enrolmentProofMessage(code), 'utf8'), proofKey).toString(
        'base64',
      ),
    };
  }

  /** Headers of a signed request for exactly this method, path and body. */
  headers(
    method: string,
    path: string,
    body = '',
    options: { timestamp?: number; nonce?: string; key?: KeyObject; id?: string } = {},
  ): Record<string, string> {
    const id = options.id ?? this.id;
    if (id === undefined) throw new Error('The test installation has not enrolled');
    const timestamp = String(options.timestamp ?? Date.now());
    const nonce = options.nonce ?? randomBytes(16).toString('base64url');
    const message = signedRequestMessage({
      method,
      path,
      timestamp,
      nonce,
      bodySha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    });
    return {
      [INSTALLATION_HEADERS.installation]: id,
      [INSTALLATION_HEADERS.timestamp]: timestamp,
      [INSTALLATION_HEADERS.nonce]: nonce,
      [INSTALLATION_HEADERS.signature]: sign(
        null,
        Buffer.from(message, 'utf8'),
        options.key ?? this.privateKey,
      ).toString('base64'),
    };
  }
}
