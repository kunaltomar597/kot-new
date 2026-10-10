import { constants, createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { crc32 } from 'node:zlib';

/**
 * Pager firmware images for tests (P2-04b): an ESP-IDF app image header with its app description,
 * signed for secure boot v2 the way `espsecure sign-data --version 2` does. Checked against
 * espsecure 5.4 (`verify-signature`, `digest-sbv2-public-key`) when written; the committed
 * fixture `test/fixtures/pager-firmware/rp-pager-1.0.0.bin` is espsecure's own output.
 */

const SECTOR = 4096;

export interface FirmwareKey {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** What the pagers' eFuse holds and `RP_PAGER_FIRMWARE_KEYS` lists. */
  readonly digest: string;
}

export function firmwareImage(options: {
  version: string;
  project?: string;
  chipId?: number;
  bodyBytes?: number;
  /** Its anti-rollback version (`secure_version`), 0 by default. */
  secureVersion?: number;
}): Buffer {
  const header = Buffer.alloc(24);
  header[0] = 0xe9;
  header[1] = 1;
  header[2] = 2;
  header[3] = 0x2f;
  header.writeUInt32LE(0x40375000, 4);
  header[8] = 0xee;
  header.writeUInt16LE(options.chipId ?? 9, 12);
  header.writeUInt16LE(0xffff, 17);
  const segment = Buffer.alloc(8);
  segment.writeUInt32LE(0x3c000020, 0);
  segment.writeUInt32LE(256, 4);
  const desc = Buffer.alloc(256);
  desc.writeUInt32LE(0xabcd5432, 0);
  desc.writeUInt32LE(options.secureVersion ?? 0, 4);
  desc.write(options.version, 16, 32, 'latin1');
  desc.write(options.project ?? 'rp-pager', 48, 32, 'latin1');
  desc.write('12:00:00', 80, 16, 'latin1');
  desc.write('Oct  5 2026', 96, 16, 'latin1');
  desc.write('v5.5.1', 112, 32, 'latin1');
  const body = Buffer.alloc(options.bodyBytes ?? 1024, 0x5a);
  return Buffer.concat([header, segment, desc, body]);
}

function bigIntOf(bytes: Buffer): bigint {
  return BigInt(`0x${bytes.toString('hex')}`);
}

function littleEndian(value: bigint, length: number): Buffer {
  const out = Buffer.alloc(length);
  let rest = value;
  for (let index = 0; index < length; index += 1) {
    out[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/** The inverse of `value` modulo 2^32 (n is odd). */
function inverse32(value: bigint): bigint {
  const modulus = 1n << 32n;
  let [oldR, r] = [value % modulus, modulus];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const quotient = oldR / r;
    [oldR, r] = [r, oldR - quotient * r];
    [oldS, s] = [s, oldS - quotient * s];
  }
  return ((oldS % modulus) + modulus) % modulus;
}

/** n, e, R and M' as the signature block and the eFuse digest hold them. */
function publicKeyBlob(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' });
  const n = bigIntOf(Buffer.from(jwk.n ?? '', 'base64url'));
  const e = Number(bigIntOf(Buffer.from(jwk.e ?? '', 'base64url')));
  const rinv = (1n << BigInt(2 * 3072)) % n;
  const mPrime = (-inverse32(n) + (1n << 32n)) % (1n << 32n);
  const exponent = Buffer.alloc(4);
  exponent.writeUInt32LE(e);
  const m = Buffer.alloc(4);
  m.writeUInt32LE(Number(mPrime));
  return Buffer.concat([littleEndian(n, 384), exponent, littleEndian(rinv, 384), m]);
}

export function firmwareKey(): FirmwareKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  return {
    privateKey,
    publicKey,
    digest: createHash('sha256').update(publicKeyBlob(publicKey)).digest('hex'),
  };
}

/** Pads the image to 4 KB with 0xFF and appends a signature sector signed by `keys`. */
export function signFirmware(image: Buffer, ...keys: FirmwareKey[]): Buffer {
  const padding = (SECTOR - (image.length % SECTOR)) % SECTOR;
  const content = Buffer.concat([image, Buffer.alloc(padding, 0xff)]);
  const digest = createHash('sha256').update(content).digest();
  const blocks = keys.map((key) => {
    const signature = sign('sha256', content, {
      key: key.privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    });
    const head = Buffer.from([0xe7, 0x02, 0, 0]);
    const data = Buffer.concat([
      head,
      digest,
      publicKeyBlob(key.publicKey),
      Buffer.from(signature).reverse(),
    ]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32LE(crc32(data));
    return Buffer.concat([data, crc, Buffer.alloc(16)]);
  });
  const sector = Buffer.concat(blocks);
  return Buffer.concat([content, sector, Buffer.alloc(SECTOR - sector.length, 0xff)]);
}
