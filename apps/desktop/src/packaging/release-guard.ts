import { createPublicKey } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { INSTALL_FOLDERS } from './payload.js';

/**
 * The release guard (P8-03b3b): what the package step refuses before electron-builder runs. A
 * signed installer is the vendor's: every restaurant PC installs it as SYSTEM, and so the updates
 * it takes. So a signed build must name the signer its updates must carry and never take unsigned
 * ones (UPD-007; threat model "The update pipeline", UPDATE-E3), be staged on Windows, and carry
 * the vendor's licence keys (LIC-003) and pager firmware keys (PGR-011): without the first every
 * restaurant that installs it restricts from the next business day, without the second no pager
 * takes firmware from its PC (threat model "The licence mechanism", LICENCE-D3). A test build may
 * lack all of these; it is never installed at a restaurant.
 */

/** What the guard judges a build by. */
export interface ReleaseFacts {
  /** A code-signing certificate is given: electron-builder signs the installer as the vendor's. */
  readonly signed: boolean;
  /** The staged update settings (`staging/installer-defines.nsh`). */
  readonly updates: { readonly publisher: boolean; readonly allowUnsigned: boolean };
  /** The system the payload's native modules were installed for. */
  readonly stagedOn: NodeJS.Platform;
  /** `--any-platform`: a test installer from a payload staged off Windows. */
  readonly anyPlatform: boolean;
  /** The keys built into the staged server. */
  readonly keys: BuiltInKeys;
}

export interface BuiltInKeys {
  /** `VENDOR_LICENCE_KEYS`: Ed25519 public keys, SPKI DER in base64. */
  readonly licence: readonly string[];
  /** `PAGER_FIRMWARE_KEY_DIGESTS`: SHA-256 digests of secure boot v2 keys, lower-case hex. */
  readonly pagerFirmware: readonly string[];
}

/** The pagers' eFuses hold three key digests. */
export const PAGER_KEY_SLOTS = 3;

function isLicenceKey(spkiBase64: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(spkiBase64)) return false;
  try {
    const key = createPublicKey({
      key: Buffer.from(spkiBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return key.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

/** Why the package step must not build this installer; empty when it may. */
export function releaseRefusals(facts: ReleaseFacts): string[] {
  const refusals: string[] = [];
  if (facts.stagedOn !== 'win32' && (facts.signed || !facts.anyPlatform)) {
    refusals.push(
      facts.signed
        ? `The payload was staged on ${facts.stagedOn}: a signed installer is staged on Windows, so its native modules run there.`
        : `The payload was staged on ${facts.stagedOn}; stage it on Windows, or pass --any-platform to build a test installer.`,
    );
  }
  if (!facts.signed) return refusals;
  if (facts.updates.allowUnsigned) {
    refusals.push(
      'A signed installer cannot accept unsigned updates: stage it without RP_ALLOW_UNSIGNED_UPDATES.',
    );
  }
  if (!facts.updates.publisher) {
    refusals.push(
      'Stage a signed installer with RP_UPDATE_PUBLISHER, the certificate’s subject, or the PCs will refuse every update.',
    );
  }
  const { licence, pagerFirmware } = facts.keys;
  if (licence.length === 0) {
    refusals.push(
      'A signed installer needs the vendor’s licence key in packages/licensing/src/vendor-keys.ts (manual task 23): without it every restaurant that installs it restricts from the next business day.',
    );
  } else if (!licence.every(isLicenceKey)) {
    refusals.push(
      'A licence key in packages/licensing/src/vendor-keys.ts is not an Ed25519 public key (SPKI DER in base64).',
    );
  }
  if (pagerFirmware.length === 0) {
    refusals.push(
      'A signed installer needs the pager firmware key’s digest in apps/server/src/pager-firmware/firmware-keys.ts (manual task 30): without it the PCs pass no firmware to their pagers.',
    );
  } else if (
    pagerFirmware.length > PAGER_KEY_SLOTS ||
    !pagerFirmware.every((digest) => /^[0-9a-f]{64}$/.test(digest))
  ) {
    refusals.push(
      `The pager firmware keys in apps/server/src/pager-firmware/firmware-keys.ts must be at most ${String(PAGER_KEY_SLOTS)} SHA-256 digests in lower-case hex.`,
    );
  }
  return refusals;
}

/**
 * Whether electron-builder will sign: it takes `WIN_CSC_LINK` when the variable is set, even
 * empty, and `CSC_LINK` otherwise.
 */
export function signedBuild(env: Readonly<Record<string, string | undefined>>): boolean {
  const link = env.WIN_CSC_LINK ?? env.CSC_LINK;
  return link !== undefined && link.trim() !== '';
}

/** The update settings the stage step wrote (`nsisDefines`). */
export function stagedUpdateSettings(defines: string): ReleaseFacts['updates'] {
  const lines = defines.split(/\r?\n/).map((line) => line.trim());
  return {
    publisher: lines.some((line) => /^!define RP_UPDATE_PUBLISHER "[^"]/.test(line)),
    allowUnsigned: lines.some((line) => /^!define RP_ALLOW_UNSIGNED_UPDATES\b/.test(line)),
  };
}

function listOf(module: unknown, name: string, file: string): readonly string[] {
  const value = (module as Record<string, unknown>)[name];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${file} has no list ${name}`);
  }
  return value;
}

/** The keys built into the staged server: what the installer will carry, not the sources. */
export async function stagedKeys(payload: string): Promise<BuiltInKeys> {
  const server = join(payload, INSTALL_FOLDERS.server);
  const licenceFile = join(server, 'node_modules', '@rp', 'licensing', 'dist', 'vendor-keys.js');
  const firmwareFile = join(server, 'dist', 'pager-firmware', 'firmware-keys.js');
  const [licence, firmware] = await Promise.all([
    import(pathToFileURL(licenceFile).href) as Promise<unknown>,
    import(pathToFileURL(firmwareFile).href) as Promise<unknown>,
  ]);
  return {
    licence: listOf(licence, 'VENDOR_LICENCE_KEYS', licenceFile),
    pagerFirmware: listOf(firmware, 'PAGER_FIRMWARE_KEY_DIGESTS', firmwareFile),
  };
}
