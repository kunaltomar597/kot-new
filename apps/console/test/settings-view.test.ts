import { SETTING_KEYS, type SettingKey } from '@rp/contracts';
import { describe, expect, it } from 'vitest';
import {
  accessOf,
  asksSecondFactor,
  checkDraft,
  draftOf,
  EDITED_ELSEWHERE,
  fieldOf,
  formatValue,
  groupOf,
  optionLabel,
  partLabel,
  percentOf,
  type PrinterNames,
  printerNamesOf,
  sameValue,
  SETTING_GROUPS,
  settingHint,
  settingLabel,
  settingSections,
  updateRequestOf,
} from '../src/manage/settings/settings-view.js';
import { t } from './harness.js';
import {
  COUNTER_PRINTER,
  OLD_PRINTER,
  PRINTERS,
  settingView,
  settingViews,
} from './settings-fixture.js';

const NO_PRINTERS: PrinterNames = new Map<string, string>();
const shown = (key: SettingKey, value: unknown, printers = NO_PRINTERS) =>
  formatValue(t, key, value, printers);

describe('[MGR-007] the settings page from the catalogue', () => {
  it('places every setting: in a group with an editor and words, or on a page of its own', () => {
    for (const key of SETTING_KEYS) {
      // Every setting has a name and a description, the ones with a page of their own too.
      expect(settingLabel(t, key), key).not.toBe('');
      expect(settingHint(t, key), key).not.toBe('');
      if (EDITED_ELSEWHERE.has(key)) continue;
      expect(SETTING_GROUPS, key).toContain(groupOf(key));
      const field = fieldOf(key);
      if (field.kind === 'choice') {
        for (const option of field.options) expect(optionLabel(t, key, option), key).not.toBe('');
      }
      if (field.kind === 'windows') {
        for (const part of field.parts) expect(partLabel(t, key, part), key).not.toBe('');
      }
      // The default reads in words, and the editor starts from it and accepts it unchanged.
      const view = settingView('OWNER', key);
      expect(shown(key, view.defaultValue), key).not.toBe('');
      const check = checkDraft(key, draftOf(key, view.defaultValue));
      expect(check, key).toEqual({ ok: true, value: view.defaultValue });
    }
    expect([...EDITED_ELSEWHERE].sort()).toEqual(['notifications.rules', 'pagers.vibration']);
  });

  it('reads each editor from the setting’s validation', () => {
    expect(fieldOf('auth.pinLength')).toEqual({ kind: 'choice', options: [4, 6] });
    expect(fieldOf('billing.priceMode')).toEqual({
      kind: 'choice',
      options: ['TAX_EXCLUSIVE', 'TAX_INCLUSIVE'],
    });
    expect(fieldOf('kds.ageAmberMinutes')).toEqual({ kind: 'number', min: 1, max: 120 });
    expect(fieldOf('billing.serviceChargeEnabled')).toEqual({ kind: 'switch' });
    expect(fieldOf('payments.otherModes')).toEqual({
      kind: 'lines',
      minLines: 1,
      maxLines: 5,
      maxLength: 30,
    });
    expect(fieldOf('bills.headerLines')).toEqual({
      kind: 'lines',
      minLines: 0,
      maxLines: 4,
      maxLength: 48,
    });
    expect(fieldOf('backups.secondLocation')).toEqual({ kind: 'text', maxLength: 260 });
    expect(fieldOf('bills.printerId')).toEqual({ kind: 'printer' });
    expect(fieldOf('updates.maintenanceWindow')).toEqual({ kind: 'window' });
    expect(fieldOf('reco.dayparts')).toEqual({
      kind: 'windows',
      parts: ['BREAKFAST', 'LUNCH', 'EVENING', 'DINNER'],
    });
  });

  it('[BILL-005] types rates in percent and amounts in rupees', () => {
    expect(percentOf(1_000)).toBe('10');
    expect(percentOf(1_250)).toBe('12.5');
    expect(percentOf(50)).toBe('0.5');
    expect(percentOf(0)).toBe('0');
    const limit = 'billing.cashierDiscountLimitBp';
    expect(draftOf(limit, 1_000)).toBe('10');
    expect(checkDraft(limit, '12.5')).toEqual({ ok: true, value: 1_250 });
    expect(checkDraft(limit, ' 15 % ')).toEqual({ ok: true, value: 1_500 });
    expect(checkDraft(limit, '12.555')).toEqual({
      ok: false,
      problem: { kind: 'number', min: 0, max: 10_000 },
    });
    expect(checkDraft(limit, '101')).toMatchObject({ ok: false });
    expect(shown(limit, 1_250)).toBe('12.5 %');
    const variance = 'audit.cashVarianceFlagPaise';
    expect(draftOf(variance, 20_000)).toBe('200.00');
    expect(checkDraft(variance, '₹1,250.50')).toEqual({ ok: true, value: 125_050 });
    expect(shown(variance, 20_000)).toBe('₹200.00');
  });

  it('shows values in words with their units', () => {
    expect(shown('kds.ageAmberMinutes', 1)).toBe('1 minute');
    expect(shown('kds.ageAmberMinutes', 10)).toBe('10 minutes');
    expect(shown('notifications.escalationSeconds', 60)).toBe('60 seconds');
    expect(shown('kds.soundVolumePercent', 70)).toBe('70 %');
    expect(shown('reco.minOrders', 1_500)).toBe('1,500 orders');
    expect(shown('auth.attemptsPerMinutePerDevice', 10)).toBe('10');
    expect(shown('billing.serviceChargeEnabled', true)).toBe(t('settings.values.on'));
    expect(shown('billing.serviceChargeEnabled', false)).toBe(t('settings.values.off'));
    expect(shown('billing.priceMode', 'TAX_INCLUSIVE')).toBe('Include GST');
    expect(shown('billing.roundingUnitPaise', 0)).toBe('No rounding');
    expect(shown('auth.pinLength', 6)).toBe('6 digits');
    expect(shown('bills.footerLines', [])).toBe(t('settings.values.none'));
    expect(shown('payments.otherModes', ['Meal card', 'Wallet'])).toBe('Meal card, Wallet');
    expect(shown('backups.secondLocation', null)).toBe(t('settings.values.none'));
    expect(shown('backups.secondLocation', 'E:\\Backups')).toBe('E:\\Backups');
    const printers = printerNamesOf(t, PRINTERS);
    expect(shown('bills.printerId', null, printers)).toBe(t('settings.values.printerEachTime'));
    expect(shown('bills.printerId', COUNTER_PRINTER, printers)).toBe('Counter printer');
    expect(shown('bills.printerId', OLD_PRINTER, printers)).toBe('Old printer (archived)');
    expect(shown('bills.printerId', OLD_PRINTER, NO_PRINTERS)).toBe(
      t('settings.values.printerGone'),
    );
    expect(shown('updates.maintenanceWindow', { start: '03:00', end: '06:00' })).toBe(
      '03:00 to 06:00',
    );
    expect(
      shown('reco.dayparts', {
        BREAKFAST: { start: '07:00', end: '11:00' },
        LUNCH: { start: '11:00', end: '16:00' },
        EVENING: { start: '16:00', end: '19:00' },
        DINNER: { start: '19:00', end: '04:00' },
      }),
    ).toBe(
      'Breakfast: 07:00 to 11:00; Lunch: 11:00 to 16:00; Evening: 16:00 to 19:00; ' +
        'Dinner: 19:00 to 04:00 the next day',
    );
  });

  it('checks what is typed as the server does', () => {
    expect(checkDraft('kds.ageAmberMinutes', '0')).toEqual({
      ok: false,
      problem: { kind: 'number', min: 1, max: 120 },
    });
    expect(checkDraft('kds.ageAmberMinutes', '12.5')).toMatchObject({ ok: false });
    expect(checkDraft('kds.ageAmberMinutes', ' 12 ')).toEqual({ ok: true, value: 12 });
    expect(checkDraft('auth.pinLength', '6')).toEqual({ ok: true, value: 6 });
    expect(checkDraft('auth.pinLength', '5')).toEqual({
      ok: false,
      problem: { kind: 'required' },
    });
    expect(checkDraft('payments.otherModes', '  \n ')).toEqual({
      ok: false,
      problem: { kind: 'tooFewLines' },
    });
    expect(checkDraft('payments.otherModes', 'Meal card\n\n  Wallet  ')).toEqual({
      ok: true,
      value: ['Meal card', 'Wallet'],
    });
    expect(checkDraft('payments.otherModes', 'a\nb\nc\nd\ne\nf')).toEqual({
      ok: false,
      problem: { kind: 'tooManyLines', max: 5 },
    });
    expect(checkDraft('payments.otherModes', 'x'.repeat(31))).toEqual({
      ok: false,
      problem: { kind: 'lineTooLong', length: 30 },
    });
    expect(checkDraft('backups.secondLocation', '   ')).toEqual({ ok: true, value: null });
    expect(checkDraft('backups.secondLocation', 'x'.repeat(261))).toEqual({
      ok: false,
      problem: { kind: 'tooLong', length: 260 },
    });
    expect(checkDraft('bills.printerId', '')).toEqual({ ok: true, value: null });
    expect(checkDraft('bills.printerId', COUNTER_PRINTER)).toEqual({
      ok: true,
      value: COUNTER_PRINTER,
    });
    expect(checkDraft('updates.maintenanceWindow', { start: '23:00', end: '02:00' })).toEqual({
      ok: true,
      value: { start: '23:00', end: '02:00' },
    });
    expect(checkDraft('updates.maintenanceWindow', { start: '', end: '02:00' })).toEqual({
      ok: false,
      problem: { kind: 'time' },
    });
    expect(
      checkDraft('reco.dayparts', {
        BREAKFAST: { start: '07:00', end: '11:00' },
        LUNCH: { start: '11:00', end: '16:00' },
        EVENING: { start: '16:00', end: '19:00' },
      }),
    ).toEqual({ ok: false, problem: { kind: 'time' } });
  });

  it('[UPD-010] [AUTH-006] says who may change a setting', () => {
    const manager = (key: SettingKey) => settingView('MANAGER', key);
    expect(accessOf(manager('kds.ageAmberMinutes'))).toBe('EDIT');
    expect(accessOf(manager('qr.pickupTimeoutSeconds'))).toBe('VENDOR');
    expect(accessOf(manager('pagers.heartbeatSeconds'))).toBe('VENDOR');
    expect(accessOf(manager('billing.serviceChargeEnabled'))).toBe('OWNER_ONLY');
    expect(accessOf(manager('backups.cloudEnabled'))).toBe('OWNER_ONLY');
    expect(accessOf(settingView('OWNER', 'billing.serviceChargeEnabled'))).toBe('EDIT');
    expect(accessOf(settingView('OWNER', 'licence.graceDays'))).toBe('VENDOR');
    // A person whose role cannot change it (here a cashier, who never sees the page).
    expect(accessOf(settingView('CASHIER', 'auth.pinLength'))).toBe('NOT_YOURS');
    expect(asksSecondFactor(manager('billing.serviceChargeEnabled'))).toBe(true);
    expect(asksSecondFactor(manager('audit.dailyReportEnabled'))).toBe(true);
    expect(asksSecondFactor(manager('kds.ageAmberMinutes'))).toBe(false);
  });

  it('groups the settings in order, and searches and filters them', () => {
    const views = [
      ...settingViews('MANAGER', { 'kds.ageAmberMinutes': 12, 'notifications.rules': {} }),
      { ...settingView('MANAGER', 'kds.ageRedMinutes'), key: 'future.setting' },
    ];
    const words = (key: SettingKey) => `${settingLabel(t, key)} ${settingHint(t, key)}`;
    const all = settingSections(views, { query: '', changedOnly: false }, words);
    expect(all.map((section) => section.group)).toEqual([...SETTING_GROUPS]);
    const keys = all.flatMap((section) => section.settings.map((setting) => setting.key));
    expect(keys).not.toContain('notifications.rules');
    expect(keys).not.toContain('pagers.vibration');
    expect(keys).not.toContain('future.setting');
    expect(keys).toHaveLength(SETTING_KEYS.length - 2);
    expect(all[1]?.settings.map((setting) => setting.key)).toEqual([
      'stock.kitchenMayManage',
      'kds.ageAmberMinutes',
      'kds.ageRedMinutes',
      'kds.readyNotCollectedMinutes',
      'kds.autoEscalateNotCollected',
      'kds.soundVolumePercent',
    ]);
    expect(
      settingSections(views, { query: '', changedOnly: true }, words).flatMap((section) =>
        section.settings.map((setting) => setting.key),
      ),
    ).toEqual(['kds.ageAmberMinutes']);
    expect(
      settingSections(views, { query: '  AMBER ', changedOnly: false }, words).flatMap((section) =>
        section.settings.map((setting) => setting.key),
      ),
    ).toEqual(['kds.ageAmberMinutes', 'kds.ageRedMinutes']);
    expect(settingSections(views, { query: 'nothing like it', changedOnly: false }, words)).toEqual(
      [],
    );
  });

  it('sends the value, with the reason when one is given', () => {
    expect(updateRequestOf(12, '  ')).toEqual({ value: 12 });
    expect(updateRequestOf(1_500, ' Festival week ')).toEqual({
      value: 1_500,
      reason: 'Festival week',
    });
    expect(sameValue({ start: '03:00', end: '06:00' }, { end: '06:00', start: '03:00' })).toBe(
      true,
    );
    expect(sameValue(['a', 'b'], ['b', 'a'])).toBe(false);
  });
});
