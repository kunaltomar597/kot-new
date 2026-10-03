import {
  constants,
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  privateDecrypt,
  publicEncrypt,
} from 'node:crypto';
import { type AwsCredentials, sha256Hex, signHeaders } from './aws-sigv4.js';

/**
 * The vendor's escrow key (DATA-003, P7-05e): an RSA key whose private half never leaves the
 * cloud KMS. Restaurant PCs wrap their backup key with its public half (RSA-OAEP, SHA-256); only
 * a KMS Decrypt, on a restore the vendor approved, unwraps it.
 */
export interface EscrowKey {
  /** Which vendor key this is: a short fingerprint of its public key. */
  readonly id: string;
  /** SPKI DER, base64, for the PCs. */
  readonly publicKey: string;
  /** Unwraps what a PC wrapped with `publicKey`. */
  unwrap(wrapped: Buffer): Promise<Buffer>;
}

export function escrowKeyIdOf(spkiDer: Buffer): string {
  return createHash('sha256').update(spkiDer).digest('hex').slice(0, 16);
}

/** Wraps a secret for a public key (RSA-OAEP, SHA-256): what the PC and the release do. */
export function wrapFor(publicKeySpkiBase64: string, secret: Buffer): Buffer {
  const key = createPublicKey({
    key: Buffer.from(publicKeySpkiBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  return publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    secret,
  );
}

/** Development and tests: the key from configuration (`CP_ESCROW_PRIVATE_KEY`). */
export class LocalEscrowKey implements EscrowKey {
  readonly id: string;
  readonly publicKey: string;
  private readonly privateKey: KeyObject;

  constructor(pkcs8Base64: string) {
    this.privateKey = createPrivateKey({
      key: Buffer.from(pkcs8Base64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    if (this.privateKey.asymmetricKeyType !== 'rsa') {
      throw new Error('CP_ESCROW_PRIVATE_KEY is not an RSA key');
    }
    const spki = createPublicKey(this.privateKey).export({ format: 'der', type: 'spki' });
    this.publicKey = spki.toString('base64');
    this.id = escrowKeyIdOf(spki);
  }

  unwrap(wrapped: Buffer): Promise<Buffer> {
    return Promise.resolve(
      privateDecrypt(
        { key: this.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        wrapped,
      ),
    );
  }
}

export interface KmsOptions {
  readonly keyId: string;
  readonly region: string;
  readonly endpoint?: string;
  readonly credentials: AwsCredentials;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

/** Production: an AWS KMS RSA_4096 ENCRYPT_DECRYPT key in India (manual task 27). */
export class KmsEscrowKey implements EscrowKey {
  private constructor(
    private readonly options: KmsOptions,
    readonly id: string,
    readonly publicKey: string,
  ) {}

  private static async call(
    options: KmsOptions,
    target: string,
    body: object,
  ): Promise<Record<string, unknown>> {
    const url = new URL(options.endpoint ?? `https://kms.${options.region}.amazonaws.com/`);
    const text = JSON.stringify(body);
    const headers = signHeaders({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': `TrentService.${target}`,
      },
      payloadHash: sha256Hex(text),
      region: options.region,
      service: 'kms',
      credentials: options.credentials,
      now: (options.now ?? (() => new Date()))(),
    });
    delete headers.host;
    const response = await (options.fetch ?? fetch)(url, { method: 'POST', headers, body: text });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const type =
        typeof json.__type === 'string' ? json.__type : `HTTP ${String(response.status)}`;
      throw new Error(`KMS ${target} failed: ${type}`);
    }
    return json;
  }

  /** Reads the key's public half once, at start-up. */
  static async open(options: KmsOptions): Promise<KmsEscrowKey> {
    const answer = await KmsEscrowKey.call(options, 'GetPublicKey', { KeyId: options.keyId });
    if (typeof answer.PublicKey !== 'string') throw new Error('KMS GetPublicKey gave no key');
    const spki = Buffer.from(answer.PublicKey, 'base64');
    return new KmsEscrowKey(options, escrowKeyIdOf(spki), answer.PublicKey);
  }

  async unwrap(wrapped: Buffer): Promise<Buffer> {
    const answer = await KmsEscrowKey.call(this.options, 'Decrypt', {
      KeyId: this.options.keyId,
      CiphertextBlob: wrapped.toString('base64'),
      EncryptionAlgorithm: 'RSAES_OAEP_SHA_256',
    });
    if (typeof answer.Plaintext !== 'string') throw new Error('KMS Decrypt gave no plaintext');
    return Buffer.from(answer.Plaintext, 'base64');
  }
}

/** The escrow key the configuration names, read once when first needed; null when not set up. */
export function escrowKeySourceFor(config: {
  readonly escrowPrivateKey?: string | undefined;
  readonly escrowKmsKeyId?: string | undefined;
  readonly escrowKmsRegion: string;
  readonly escrowKmsEndpoint?: string | undefined;
  readonly escrowKmsAccessKeyId?: string | undefined;
  readonly escrowKmsSecretAccessKey?: string | undefined;
}): () => Promise<EscrowKey | null> {
  let opened: Promise<EscrowKey | null> | undefined;
  return () => {
    if (config.escrowPrivateKey !== undefined) {
      opened ??= Promise.resolve(new LocalEscrowKey(config.escrowPrivateKey));
    } else if (
      config.escrowKmsKeyId !== undefined &&
      config.escrowKmsAccessKeyId !== undefined &&
      config.escrowKmsSecretAccessKey !== undefined
    ) {
      const options: KmsOptions = {
        keyId: config.escrowKmsKeyId,
        region: config.escrowKmsRegion,
        ...(config.escrowKmsEndpoint !== undefined && { endpoint: config.escrowKmsEndpoint }),
        credentials: {
          accessKeyId: config.escrowKmsAccessKeyId,
          secretAccessKey: config.escrowKmsSecretAccessKey,
        },
      };
      // A failed read (the KMS unreachable) is tried again next time.
      opened ??= KmsEscrowKey.open(options).catch((error: unknown) => {
        opened = undefined;
        throw error;
      });
    } else {
      return Promise.resolve(null);
    }
    return opened;
  };
}
