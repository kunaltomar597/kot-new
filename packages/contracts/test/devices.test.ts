import { describe, expect, it } from 'vitest';
import {
  CreatePairingCodeRequest,
  DeviceRevoked,
  DeviceTokenRequest,
  deviceTokenMessage,
  PairDeviceRequest,
  PairingCode,
  pairingProofMessage,
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
