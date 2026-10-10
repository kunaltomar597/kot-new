import { constants, generateKeyPairSync, privateDecrypt, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  escrowKeySourceFor,
  KmsEscrowKey,
  LocalEscrowKey,
  wrapFor,
} from '../../src/cloud-backups/escrow-keys.js';
import { loadConfig } from '../../src/config/cp-config.js';

const vendor = generateKeyPairSync('rsa', { modulusLength: 3072 });
const PKCS8 = vendor.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const SPKI = vendor.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

describe('[DATA-003] the vendor’s escrow key', () => {
  it('unwraps what a PC wrapped with its public half (RSA-OAEP, SHA-256)', async () => {
    const key = new LocalEscrowKey(PKCS8);
    expect(key.publicKey).toBe(SPKI);
    expect(key.id).toMatch(/^[0-9a-f]{16}$/);
    const secret = randomBytes(32);
    const wrapped = wrapFor(key.publicKey, secret);
    expect(wrapped.length).toBe(384);
    expect((await key.unwrap(wrapped)).equals(secret)).toBe(true);
    // Each wrapping is different (OAEP is randomised).
    expect(wrapFor(key.publicKey, secret).equals(wrapped)).toBe(false);
  });

  it('asks the KMS for the public key and to decrypt, signed for the kms service', async () => {
    const calls: { target: string | null; auth: string | null; body: Record<string, unknown> }[] =
      [];
    const fetch = (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >;
      calls.push({ target: headers.get('x-amz-target'), auth: headers.get('authorization'), body });
      if (headers.get('x-amz-target') === 'TrentService.GetPublicKey') {
        return Promise.resolve(Response.json({ PublicKey: SPKI }));
      }
      // As the KMS does: decrypt with the private key it never lets out.
      const plain = privateDecrypt(
        { key: vendor.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(String(body.CiphertextBlob), 'base64'),
      );
      return Promise.resolve(Response.json({ Plaintext: plain.toString('base64') }));
    };
    const key = await KmsEscrowKey.open({
      keyId: 'alias/rp-escrow',
      region: 'ap-south-1',
      credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
      fetch,
    });
    expect(key.publicKey).toBe(SPKI);
    const secret = randomBytes(32);
    expect((await key.unwrap(wrapFor(key.publicKey, secret))).equals(secret)).toBe(true);
    expect(calls.map((call) => call.target)).toEqual([
      'TrentService.GetPublicKey',
      'TrentService.Decrypt',
    ]);
    expect(calls[1]?.body).toMatchObject({
      KeyId: 'alias/rp-escrow',
      EncryptionAlgorithm: 'RSAES_OAEP_SHA_256',
    });
    expect(calls[1]?.auth).toMatch(/\/ap-south-1\/kms\/aws4_request, SignedHeaders=/);
  });

  it('reports a KMS refusal, and has no key when none is configured', async () => {
    const refused = () =>
      Promise.resolve(Response.json({ __type: 'AccessDeniedException' }, { status: 400 }));
    await expect(
      KmsEscrowKey.open({
        keyId: 'k',
        region: 'ap-south-1',
        credentials: { accessKeyId: 'a', secretAccessKey: 's' },
        fetch: refused,
      }),
    ).rejects.toThrow(/AccessDeniedException/);
    expect(await escrowKeySourceFor({ escrowKmsRegion: 'ap-south-1' })()).toBeNull();
  });

  it('keeps the key in the KMS, in India, outside development', () => {
    const production = {
      DATABASE_URL: 'postgresql://cp@db.example.in/cp?sslmode=require',
      CP_ENV: 'production',
      CP_TRUST_PROXY: '1',
      CP_SECRET_KEY: randomBytes(32).toString('base64'),
    };
    expect(() => loadConfig({ ...production, CP_ESCROW_PRIVATE_KEY: PKCS8 })).toThrow(/KMS/);
    const kms = {
      ...production,
      CP_ESCROW_KMS_KEY_ID: 'alias/rp-escrow',
      CP_ESCROW_KMS_ACCESS_KEY_ID: 'AKIA',
      CP_ESCROW_KMS_SECRET_ACCESS_KEY: 'secret',
    };
    expect(loadConfig(kms).escrowKmsRegion).toBe('ap-south-1');
    expect(() => loadConfig({ ...kms, CP_ESCROW_KMS_REGION: 'eu-west-1' })).toThrow(/India/);
    expect(() => loadConfig({ ...kms, CP_ESCROW_KMS_ACCESS_KEY_ID: '' })).toThrow(
      /CP_ESCROW_KMS_ACCESS_KEY_ID/,
    );
  });
});
