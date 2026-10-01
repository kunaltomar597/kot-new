import { describe, expect, it } from 'vitest';
import {
  OrderLineRequest,
  QrRelaySettings,
  QrSubmitOrderRequest,
  RelayCredential,
  TableToken,
  TokenHash,
} from '../src/relay/index.js';
import { settingDefinition } from '../src/settings.js';

const KEYS = {
  submissionsPerWindow: 'qr.submissionsPerWindow',
  rateLimitWindowMinutes: 'qr.rateLimitWindowMinutes',
  pickupTimeoutSeconds: 'qr.pickupTimeoutSeconds',
  presenceIntervalSeconds: 'qr.presenceIntervalSeconds',
  readOnlyAfterSeconds: 'qr.readOnlyAfterSeconds',
} as const;

const PROBES = [
  0, 1, 4, 5, 6, 10, 14, 15, 29, 30, 31, 49, 50, 51, 60, 119, 120, 121, 299, 300, 301, 599, 600,
  601, 1_799, 1_800, 1_801,
];

describe('[QR-006] [QR-007] [QR-008] the relay’s QR settings', () => {
  it.each(Object.entries(KEYS))('%s accepts exactly what %s accepts', (field, key) => {
    const definition = settingDefinition(key);
    expect(definition).toBeDefined();
    const schema = QrRelaySettings.shape[field as keyof typeof KEYS];
    for (const value of PROBES) {
      expect(schema.safeParse(value).success, String(value)).toBe(
        definition?.schema.safeParse(value).success,
      );
    }
    expect(schema.safeParse(definition?.defaultValue).success).toBe(true);
  });
});

describe('[QR-001] [VCP-002] relay secrets', () => {
  it('takes table tokens of at least 128 bits and credentials of at least 256', () => {
    expect(TableToken.safeParse('A'.repeat(21)).success).toBe(false);
    expect(TableToken.safeParse('A'.repeat(22)).success).toBe(true);
    expect(TableToken.safeParse('A'.repeat(21) + '=').success).toBe(false);
    expect(RelayCredential.safeParse('A'.repeat(42)).success).toBe(false);
    expect(RelayCredential.safeParse('A'.repeat(43)).success).toBe(true);
    expect(TokenHash.safeParse('ab'.repeat(32)).success).toBe(true);
    expect(TokenHash.safeParse('AB'.repeat(32)).success).toBe(false);
  });
});

describe('[ORD-014] [QR-005] a diner’s order', () => {
  it('carries no prices and no table: the token is the table', () => {
    const line = OrderLineRequest.parse({
      clientLineId: '0199a0e0-0000-7000-8000-000000000001',
      itemId: '0199a0e0-0000-7000-8000-000000000002',
      quantity: 1,
    });
    const order = { idempotencyKey: '0199a0e0-0000-7000-8000-000000000003', lines: [line] };
    expect(QrSubmitOrderRequest.safeParse(order).success).toBe(true);
    expect(QrSubmitOrderRequest.safeParse({ ...order, total: 100 }).success).toBe(false);
    expect(QrSubmitOrderRequest.safeParse({ ...order, tableId: line.itemId }).success).toBe(false);
  });
});
