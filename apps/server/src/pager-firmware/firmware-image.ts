import { constants, createHash, createPublicKey, verify } from 'node:crypto';
import { crc32 } from 'node:zlib';
import type { PagerFirmwareProblem } from '@rp/contracts';
import { PAGER_FIRMWARE_CHIP_ID, PAGER_FIRMWARE_PROJECT } from '@rp/domain';

/**
 * Checks a pager firmware image before the PC passes it on (PGR-011, UPD-007, P2-04b): that it is
 * an ESP-IDF app image for the ESP32-S3, of the pager project and the release's version, and that
 * one of its secure boot v2 signature blocks verifies with a key the pagers trust. The pager's
 * bootloader checks the same signature against the key digest burned into its eFuses; checking it
 * here first means a wrong or tampered image never reaches a pager.
 *
 * Formats (ESP-IDF 5, `esp_image_format.h`, `esp_app_desc.h`; secure boot v2 as `espsecure.py`
 * writes it):
 * - image header, 24 bytes: magic 0xE9 at 0, chip id (u16 LE) at 12; then the first segment's
 *   8-byte header, so `esp_app_desc_t` starts at 32: magic 0xABCD5432, secure_version, two
 *   reserved words, version[32], project_name[32], time[16], date[16], idf_ver[32], …;
 * - the signed image is padded to 4 KB and followed by one 4 KB signature sector holding up to
 *   three 1216-byte blocks: magic 0xE7, version 0x02 (RSA-3072), two zero bytes, SHA-256 of the
 *   image before the sector, then the public key as n (384 bytes), e (u32), R (384), M' (u32),
 *   the RSA-PSS signature (SHA-256, MGF1, salt 32; 384 bytes), a CRC-32 of the 1196 bytes before
 *   it and 16 bytes of padding. Big numbers are little-endian. A key's digest (what the eFuse
 *   holds) is the SHA-256 of n, e, R and M'.
 */

const IMAGE_MAGIC = 0xe9;
const CHIP_ID_OFFSET = 12;
const APP_DESC_OFFSET = 32;
const APP_DESC_MAGIC = 0xabcd5432;
const APP_DESC_SIZE = 256;
const SECTOR = 4096;
const BLOCK_SIZE = 1216;
const BLOCK_MAGIC = 0xe7;
const BLOCK_VERSION_RSA = 0x02;
const BLOCKS_PER_SECTOR = 3;
const BLOCK_CRC_OFFSET = 1196;
const KEY_START = 36;
const KEY_END = 812;
const RSA_BYTES = 384;

export class FirmwareImageError extends Error {
  constructor(
    readonly problem: PagerFirmwareProblem,
    message: string,
  ) {
    super(message);
    this.name = 'FirmwareImageError';
  }
}

export interface FirmwareImageInfo {
  readonly version: string;
  readonly projectName: string;
  readonly chipId: number;
  /** The anti-rollback version (`CONFIG_BOOTLOADER_APP_SECURE_VERSION`). */
  readonly secureVersion: number;
  readonly idfVersion: string;
}

export interface CheckedFirmwareImage {
  readonly info: FirmwareImageInfo;
  /** The trusted key whose signature verified (hex SHA-256 of its public key). */
  readonly keyDigest: string;
}

function text(buffer: Buffer, start: number, length: number): string {
  const field = buffer.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('latin1');
}

/** The image header and its app description, or why it is not a pager firmware image. */
export function readFirmwareImage(image: Buffer): FirmwareImageInfo {
  if (
    image.length < APP_DESC_OFFSET + APP_DESC_SIZE ||
    image[0] !== IMAGE_MAGIC ||
    image.readUInt32LE(APP_DESC_OFFSET) !== APP_DESC_MAGIC
  ) {
    throw new FirmwareImageError('NOT_AN_IMAGE', 'The file is not an ESP-IDF app image.');
  }
  return {
    chipId: image.readUInt16LE(CHIP_ID_OFFSET),
    secureVersion: image.readUInt32LE(APP_DESC_OFFSET + 4),
    version: text(image, APP_DESC_OFFSET + 16, 32),
    projectName: text(image, APP_DESC_OFFSET + 48, 32),
    idfVersion: text(image, APP_DESC_OFFSET + 112, 32),
  };
}

/** The public key digest the pager's eFuse holds for the key in a signature block. */
export function signatureKeyDigest(block: Buffer): string {
  return createHash('sha256').update(block.subarray(KEY_START, KEY_END)).digest('hex');
}

/** A little-endian big number as unpadded big-endian base64url (JWK). */
function jwkNumber(littleEndian: Buffer): string {
  const bigEndian = Buffer.from(littleEndian).reverse();
  let start = 0;
  while (start < bigEndian.length - 1 && bigEndian[start] === 0) start += 1;
  return bigEndian.subarray(start).toString('base64url');
}

function blockVerifies(block: Buffer, content: Buffer, digest: Buffer): boolean {
  if (!block.subarray(4, KEY_START).equals(digest)) return false;
  const exponent = Buffer.alloc(4);
  exponent.writeUInt32LE(block.readUInt32LE(KEY_START + RSA_BYTES));
  try {
    const key = createPublicKey({
      key: {
        kty: 'RSA',
        n: jwkNumber(block.subarray(KEY_START, KEY_START + RSA_BYTES)),
        e: jwkNumber(exponent),
      },
      format: 'jwk',
    });
    const signature = Buffer.from(block.subarray(KEY_END, KEY_END + RSA_BYTES)).reverse();
    return verify(
      'sha256',
      content,
      { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
      signature,
    );
  } catch {
    return false;
  }
}

/**
 * Checks the secure boot v2 signature (UPD-007): at least one well-formed RSA block in the
 * signature sector whose key is trusted and whose signature over the image verifies. Returns that
 * key's digest. ECDSA blocks are not for the ESP32-S3 and are skipped.
 */
export function verifyFirmwareSignature(image: Buffer, trustedKeys: readonly string[]): string {
  if (trustedKeys.length === 0) {
    throw new FirmwareImageError(
      'NO_TRUSTED_KEY',
      'This software trusts no pager firmware key yet, so it passes no firmware on.',
    );
  }
  if (image.length < 2 * SECTOR || image.length % SECTOR !== 0) {
    throw new FirmwareImageError('NOT_SIGNED', 'The image carries no secure boot signature.');
  }
  const content = image.subarray(0, image.length - SECTOR);
  const sector = image.subarray(image.length - SECTOR);
  const digest = createHash('sha256').update(content).digest();
  const trusted = new Set(trustedKeys.map((key) => key.toLowerCase()));
  let signed = false;
  let byTrustedKey = false;
  for (let index = 0; index < BLOCKS_PER_SECTOR; index += 1) {
    const block = sector.subarray(index * BLOCK_SIZE, (index + 1) * BLOCK_SIZE);
    if (block[0] !== BLOCK_MAGIC || block[1] !== BLOCK_VERSION_RSA) continue;
    if (crc32(block.subarray(0, BLOCK_CRC_OFFSET)) !== block.readUInt32LE(BLOCK_CRC_OFFSET)) {
      continue;
    }
    signed = true;
    const keyDigest = signatureKeyDigest(block);
    if (!trusted.has(keyDigest)) continue;
    byTrustedKey = true;
    if (blockVerifies(block, content, digest)) return keyDigest;
  }
  if (!signed) {
    throw new FirmwareImageError('NOT_SIGNED', 'The image carries no secure boot signature.');
  }
  if (!byTrustedKey) {
    throw new FirmwareImageError(
      'UNTRUSTED_KEY',
      'The image is signed with a key the pagers do not trust.',
    );
  }
  throw new FirmwareImageError('BAD_SIGNATURE', 'The image’s signature does not verify.');
}

/**
 * Everything the PC checks before it serves an image to its pagers: the image is the pager
 * project's, for the ESP32-S3, of the release's version, and signed with a trusted key.
 */
export function checkFirmwareImage(
  image: Buffer,
  expected: { readonly version: string },
  trustedKeys: readonly string[],
): CheckedFirmwareImage {
  const info = readFirmwareImage(image);
  if (info.chipId !== PAGER_FIRMWARE_CHIP_ID) {
    throw new FirmwareImageError(
      'WRONG_CHIP',
      `The image is for chip ${String(info.chipId)}, not the pagers’ ESP32-S3.`,
    );
  }
  if (info.projectName !== PAGER_FIRMWARE_PROJECT) {
    throw new FirmwareImageError(
      'WRONG_PROJECT',
      `The image is “${info.projectName}”, not the pager firmware.`,
    );
  }
  if (info.version !== expected.version) {
    throw new FirmwareImageError(
      'VERSION_MISMATCH',
      `The image says version ${info.version}; the release is ${expected.version}.`,
    );
  }
  return { info, keyDigest: verifyFirmwareSignature(image, trustedKeys) };
}
