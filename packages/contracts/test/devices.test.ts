import { describe, expect, it } from 'vitest';
import {
  CreatePairingCodeRequest,
  DeviceRevoked,
  DeviceTokenRequest,
  deviceTokenMessage,
  PairDeviceRequest,
  PairingCode,
  PairingCodeResponse,
  pairingProofMessage,
  parsePairingQr,
} from '../src/index.js';

const id = '0199a000-0000-7000-8000-000000000001';

describe('[AUTH-007] device pairing contracts', () => {
  it('builds the exact messages devices sign', () => {
    expect(pairingProofMessage('K7Q2-M9XD')).toBe('rp-pair:v1:K7Q2-M9XD');
    expect(deviceTokenMessage(id, 'abc')).toBe(`rp-device-token:v1:${id}:abc`);
  });

  it('accepts pairing codes without look-alike characters only', () => {
    expect(PairingCode.safeParse('K7Q2-M9XD').success).toBe(true);
    for (const bad of ['K7Q2M9XD', 'k7q2-m9xd', 'K7Q0-M9XD', 'K7QI-M9XD', 'K7Q1-M9XD']) {
      expect(PairingCode.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('[AUTH-009] requires a table for a table tablet', () => {
    expect(
      CreatePairingCodeRequest.safeParse({ type: 'TABLE_TABLET', name: 'Tablet 4' }).success,
    ).toBe(false);
    expect(
      CreatePairingCodeRequest.safeParse({ type: 'TABLE_TABLET', name: 'Tablet 4', tableId: id })
        .success,
    ).toBe(true);
    expect(CreatePairingCodeRequest.safeParse({ type: 'POS', name: '  ' }).success).toBe(false);
  });

  it('accepts only the supported key algorithms and base64 keys, and nothing extra', () => {
    const request = {
      code: 'K7Q2-M9XD',
      algorithm: 'Ed25519',
      publicKey: 'MCowBQYDK2VwAyEA',
      proof: 'c2lnbmF0dXJl',
    };
    expect(PairDeviceRequest.safeParse(request).success).toBe(true);
    expect(PairDeviceRequest.safeParse({ ...request, algorithm: 'RS256' }).success).toBe(false);
    expect(PairDeviceRequest.safeParse({ ...request, publicKey: 'not base64!' }).success).toBe(
      false,
    );
    expect(PairDeviceRequest.safeParse({ ...request, extra: 1 }).success).toBe(false);
    expect(
      DeviceTokenRequest.safeParse({ deviceId: id, challenge: 'short', signature: 'c2ln' }).success,
    ).toBe(false);
  });

  it('[AUTH-007] [SEC-010] reads the pairing QR code: code, CA fingerprint and server addresses', () => {
    const ca = Array.from({ length: 32 }, (_, index) =>
      (index + 16).toString(16).toUpperCase(),
    ).join(':');
    const scanned = parsePairingQr(
      JSON.stringify({
        v: 1,
        code: 'K7Q2-M9XD',
        ca,
        urls: ['https://192.168.1.20:8443', 'http://10.0.2.2:3000'],
        later: 'a field a newer server adds',
      }),
    );
    expect(scanned).toEqual({
      v: 1,
      code: 'K7Q2-M9XD',
      ca,
      urls: ['https://192.168.1.20:8443', 'http://10.0.2.2:3000'],
    });
    // Older servers and development servers leave out the addresses and the CA.
    expect(parsePairingQr('{"v":1,"code":"K7Q2-M9XD"}')).toEqual({ v: 1, code: 'K7Q2-M9XD' });
    for (const bad of [
      'not json',
      'https://example.com',
      '{"v":2,"code":"K7Q2-M9XD"}',
      '{"v":1,"code":"k7q2-m9xd"}',
      '{"v":1,"code":"K7Q2-M9XD","ca":"3a:7f"}',
      '{"v":1,"code":"K7Q2-M9XD","urls":["ftp://192.168.1.20"]}',
      'null',
    ]) {
      expect(parsePairingQr(bad), bad).toBeUndefined();
    }
  });

  it('[AUTH-007] lists where devices reach the server with every pairing code', () => {
    const response = {
      code: 'K7Q2-M9XD',
      expiresAt: '2026-09-27T10:10:00.000Z',
      caSha256: null,
      serverUrls: ['http://192.168.1.20:8080'],
      qrPayload: '{"v":1,"code":"K7Q2-M9XD","urls":["http://192.168.1.20:8080"]}',
    };
    expect(PairingCodeResponse.safeParse(response).success).toBe(true);
    expect(
      PairingCodeResponse.safeParse({ ...response, caSha256: 'not a fingerprint' }).success,
    ).toBe(false);
  });

  it('[AUTH-008] describes unpairing as a versioned domain event', () => {
    const event = {
      eventId: id,
      type: 'DeviceRevoked',
      version: 1,
      occurredAt: '2026-09-25T10:00:00.000Z',
      restaurantId: id,
      businessDate: '2026-09-25',
      payload: { deviceId: id, deviceType: 'WAITER_PHONE', reason: 'Lost' },
    };
    expect(DeviceRevoked.safeParse(event).success).toBe(true);
  });
});
