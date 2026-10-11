import { LicencePayload, type SignedLicence } from '@rp/contracts/control-plane';
import { createHash, createPublicKey, type KeyObject, sign, verify } from 'node:crypto';

/**
 * Licence files (LIC-001, LIC-003): the vendor signs the payload's exact JSON text with Ed25519;
 * an installation accepts a file only when one of the vendor keys built into it signed that text.
 * The signing key itself lives only in the vendor's cloud KMS.
 */

/** The first 16 hex digits of the SHA-256 of a public key (SPKI DER, base64). */
export function keyIdOf(spkiBase64: string): string {
  return createHash('sha256').update(Buffer.from(spkiBase64, 'base64')).digest('hex').slice(0, 16);
}

function publicKeyOf(spkiBase64: string): KeyObject | undefined {
  try {
    const key = createPublicKey({
      key: Buffer.from(spkiBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return key.asymmetricKeyType === 'ed25519' ? key : undefined;
  } catch {
    return undefined;
  }
}

/** Signs a payload: what the Control Plane's signer does (with its KMS key in production). */
export function signLicence(
  payload: LicencePayload,
  privateKey: KeyObject,
  publicKeySpki: string,
): SignedLicence {
  const text = JSON.stringify(LicencePayload.parse(payload));
  return {
    payload: text,
    signature: sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64'),
    keyId: keyIdOf(publicKeySpki),
  };
}

function signatureMatches(file: SignedLicence, key: KeyObject): boolean {
  const signature = Buffer.from(file.signature, 'base64');
  if (signature.length !== 64) return false;
  try {
    return verify(null, Buffer.from(file.payload, 'utf8'), key, signature);
  } catch {
    return false;
  }
}

export type LicenceFileProblem = 'MISSING' | 'UNKNOWN_KEY' | 'TAMPERED' | 'MALFORMED';

export type VerifiedLicence =
  | { readonly ok: true; readonly payload: LicencePayload }
  | { readonly ok: false; readonly problem: LicenceFileProblem };

/**
 * Checks a licence file against the vendor keys built into the software: the key it names must be
 * one of them, its signature must match the payload text, and the payload must read as a licence.
 * Never throws: anything wrong is a problem, and the installation is restricted for it.
 */
export function verifyLicence(
  file: SignedLicence | undefined,
  vendorKeys: readonly string[],
): VerifiedLicence {
  if (file === undefined) return { ok: false, problem: 'MISSING' };
  const spki = vendorKeys.find((key) => keyIdOf(key) === file.keyId);
  const key = spki === undefined ? undefined : publicKeyOf(spki);
  if (key === undefined) return { ok: false, problem: 'UNKNOWN_KEY' };
  if (!signatureMatches(file, key)) return { ok: false, problem: 'TAMPERED' };
  try {
    const parsed = LicencePayload.safeParse(JSON.parse(file.payload));
    return parsed.success
      ? { ok: true, payload: parsed.data }
      : { ok: false, problem: 'MALFORMED' };
  } catch {
    return { ok: false, problem: 'MALFORMED' };
  }
}
