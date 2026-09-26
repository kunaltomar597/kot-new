import { describe, expect, it } from 'vitest';
import {
  crossSettingProblems,
  SETTING_KEYS,
  SETTINGS,
  SettingKeyParams,
  settingDefinition,
} from '../src/settings.js';

function defaultOf(key: string): unknown {
  const definition = settingDefinition(key);
  if (definition === undefined) throw new Error(`No setting ${key}`);
  return definition.defaultValue;
}

describe('[MGR-007] [UPD-010] settings catalogue', () => {
  it.each(SETTINGS.map((definition) => [definition.key, definition] as const))(
    '%s has a default its own validation accepts',
    (_key, definition) => {
      const parsed = definition.schema.safeParse(definition.defaultValue);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      expect(parsed.data).toEqual(definition.defaultValue);
      expect(definition.description.length).toBeGreaterThan(10);
      expect(definition.requirements.length).toBeGreaterThan(0);
    },
  );

  it('has unique keys in the stored form `area.name`', () => {
    expect(new Set(SETTING_KEYS).size).toBe(SETTING_KEYS.length);
    for (const key of SETTING_KEYS)
      expect(SettingKeyParams.safeParse({ key }).success, key).toBe(true);
    expect(settingDefinition('nope.nothing')).toBeUndefined();
  });

  it('rejects values outside each setting’s range', () => {
    const probes: [string, unknown][] = [
      ['auth.pinLength', 5],
      ['auth.accessTokenMinutes', 16],
      ['billing.cashierDiscountLimitBp', 10_001],
      ['billing.cashierDiscountLimitBp', 12.5],
      ['billing.priceMode', 'SOMETIMES'],
      ['payments.otherModes', []],
      ['updates.maintenanceWindow', { start: '3am', end: '06:00' }],
      ['reco.dayparts', { BREAKFAST: { start: '07:00', end: '11:00' } }],
      ['backups.secondLocation', ''],
    ];
    for (const [key, value] of probes) {
      expect(
        settingDefinition(key)?.schema.safeParse(value).success,
        `${key} = ${JSON.stringify(value)}`,
      ).toBe(false);
    }
  });

  it('keeps the BRD defaults', () => {
    const expected: Record<string, unknown> = {
      'auth.pinLength': 4, // AUTH-001
      'auth.lockoutMinutes': 15, // AUTH-003
      'auth.accessTokenMinutes': 15, // AUTH-005
      'auth.inactivityMinutes': 10, // AUTH-005
      'auth.kitchenIndividualLogins': false, // AUTH-005
      'auth.pairingCodeMinutes': 10, // AUTH-007
      'stock.kitchenMayManage': true, // OI-11
      'billing.cashierDiscountLimitBp': 1_000, // BILL-005: cashier ≤ 10 %
      'billing.serviceChargeEnabled': false, // BILL-006, OI-12
      'bills.hostedCopyDays': 30, // BILL-012
      'orders.specialInstructionsMaxLength': 140, // ORD-015
      'notifications.escalationSeconds': 60, // NTF-005, OI-02
      'notifications.repeatSeconds': 60, // OI-02
      'kds.ageAmberMinutes': 10, // KDS-004
      'kds.ageRedMinutes': 20, // KDS-004
      'kds.readyNotCollectedMinutes': 3, // KDS-006
      'kds.autoEscalateNotCollected': false, // KDS-006 (S)
      'devices.lowBatteryAlertPercent': 20, // TAB-015
      'pager.lowBatteryPercent': 15, // PGR-013
      'pager.heartbeatSeconds': 30, // PGR-007
      'qr.submissionsPerWindow': 5, // QR-006
      'qr.rateLimitWindowMinutes': 10, // QR-006
      'qr.pickupTimeoutSeconds': 60, // QR-007
      'qr.presenceIntervalSeconds': 30, // QR-008
      'qr.readOnlyAfterSeconds': 120, // QR-008: 2 minutes
      'reco.learningWindowDays': 90, // REC-003
      'reco.minOrders': 300, // REC-003
      'reco.bestSellerDays': 30, // REC-004
      'backups.keepDaily': 14, // DATA-002
      'backups.keepWeekly': 8, // DATA-002
      'backups.cloudEnabled': true, // DATA-003: on by default
      'storage.warnPercent': 80, // DATA-006
      'storage.criticalPercent': 90, // DATA-006
      'retention.operationalDays': 90, // DATA-007
      'retention.dinerContactMonths': 24, // §9.3
      'retention.feedbackMonths': 24, // §9.3
      'updates.maintenanceWindow': { start: '03:00', end: '06:00' }, // UPD-004
      'licence.validityDays': 30, // LIC-002
      'licence.graceDays': 7, // LIC-005
      'controlPlane.heartbeatSeconds': 300, // VCP-005: every 5 minutes
      'onboarding.minFreeDiskGb': 20, // ONB-002
    };
    for (const [key, value] of Object.entries(expected)) expect(defaultOf(key), key).toEqual(value);
  });

  it('marks the values the vendor controls as vendor-scoped', () => {
    const vendor = SETTINGS.filter((definition) => definition.scope === 'VENDOR').map(
      (definition) => definition.key,
    );
    expect(vendor).toEqual(
      expect.arrayContaining([
        'licence.validityDays',
        'licence.graceDays',
        'qr.pickupTimeoutSeconds',
        'controlPlane.heartbeatSeconds',
      ]),
    );
  });

  it('[AUTH-006] [ONB-004] leaves tax and invoice settings to the Owner', () => {
    // ONB-004 steps 2 and 3: price mode, rounding, header and footer, service charge.
    for (const key of [
      'billing.priceMode',
      'billing.roundingUnitPaise',
      'billing.serviceChargeEnabled',
      'billing.serviceChargeRateBp',
      'bills.headerLines',
      'bills.footerLines',
    ]) {
      expect(settingDefinition(key)?.capability, key).toBe('TAX_AND_INVOICE_SETTINGS');
    }
    const footer = settingDefinition('bills.footerLines');
    expect(footer?.schema.safeParse(['Thank you, visit again']).success).toBe(true);
    expect(footer?.schema.safeParse(['x'.repeat(49)]).success).toBe(false);
    expect(footer?.schema.safeParse(['1', '2', '3', '4', '5']).success).toBe(false);
  });

  it('checks the rules between settings', () => {
    const defaults = Object.fromEntries(
      SETTINGS.map((definition) => [definition.key, definition.defaultValue]),
    );
    expect(crossSettingProblems(defaults)).toEqual([]);
    expect(crossSettingProblems({ ...defaults, 'kds.ageRedMinutes': 10 })).toEqual([
      'The red age must be later than the amber age.',
    ]);
    expect(crossSettingProblems({ ...defaults, 'storage.criticalPercent': 80 })).toHaveLength(1);
  });
});
