import { SETTINGS } from '@rp/contracts';
import { describe, expect, it } from 'vitest';
import {
  bpText,
  checkedValue,
  draftOf,
  editorOf,
  groupSettings,
  needsOwner,
  parseBp,
  valueOf,
} from '../src/manage/settings/settings-view.js';
import { t } from './harness.js';
import { settingView } from './settings-fixture.js';

describe('[MGR-007] [NFR-L02] every setting can be shown and changed', () => {
  it('has an editor, a label and a hint for each catalogue setting', () => {
    for (const setting of SETTINGS) {
      expect(editorOf(setting.key), setting.key).toBeDefined();
      const label = t(`settingLabels.${setting.key}`);
      const hint = t(`settingHints.${setting.key}`);
      expect(label, setting.key).not.toContain('settingLabels');
      expect(hint, setting.key).not.toContain('settingHints');
    }
  });

  it('turns each default into a draft and back to a value the catalogue accepts', () => {
    for (const setting of SETTINGS) {
      const editor = editorOf(setting.key);
      if (editor === undefined || editor.kind === 'RULES') continue;
      const parsed = checkedValue(setting.key, editor, draftOf(editor, setting.defaultValue));
      expect(parsed, setting.key).toEqual({ ok: true, value: setting.defaultValue });
    }
  });
});

describe('[MGR-007] what people type', () => {
  it('reads basis points as percent without floating point', () => {
    expect(bpText(1000)).toBe('10');
    expect(bpText(50)).toBe('0.5');
    expect(bpText(1250)).toBe('12.5');
    expect(parseBp('12.5')).toBe(1250);
    expect(parseBp('0.05 %')).toBe(5);
    expect(parseBp('12.345')).toBeUndefined();
    const discount = editorOf('billing.cashierDiscountLimitBp');
    expect(discount).toMatchObject({ kind: 'NUMBER', scale: 'BP', min: 0, max: 10_000 });
    expect(checkedValue('billing.cashierDiscountLimitBp', discount!, '15')).toEqual({
      ok: true,
      value: 1500,
    });
    expect(checkedValue('billing.cashierDiscountLimitBp', discount!, '150')).toEqual({ ok: false });
  });

  it('reads rupees as paise, lists one per line, and times as windows', () => {
    const variance = editorOf('audit.cashVarianceFlagPaise')!;
    expect(draftOf(variance, 20_000)).toBe('200.00');
    expect(valueOf(variance, '250.50')).toEqual({ ok: true, value: 25_050 });
    const header = editorOf('bills.headerLines')!;
    expect(valueOf(header, ' Pure veg kitchen \n\n Since 1999 ')).toEqual({
      ok: true,
      value: ['Pure veg kitchen', 'Since 1999'],
    });
    const window = editorOf('updates.maintenanceWindow')!;
    expect(window.kind).toBe('WINDOW');
    expect(
      checkedValue('updates.maintenanceWindow', window, { start: '02:00', end: '05:30' }),
    ).toEqual({
      ok: true,
      value: { start: '02:00', end: '05:30' },
    });
    expect(
      checkedValue('updates.maintenanceWindow', window, { start: '2am', end: '05:30' }),
    ).toEqual({ ok: false });
  });

  it('edits objects field by field and records by key, leaving defaults out', () => {
    const patterns = editorOf('pager.vibrationPatterns')!;
    expect(patterns.kind).toBe('FIELDS');
    const draft = draftOf(patterns, {
      READY: 'ONE_LONG',
      SERVICE_REQUEST: 'TWO_SHORT',
      MANAGER: 'THREE_SHORT',
    });
    expect(
      checkedValue('pager.vibrationPatterns', patterns, {
        ...(draft as object),
        READY: 'LONG_SHORT',
      }),
    ).toEqual({
      ok: true,
      value: { READY: 'LONG_SHORT', SERVICE_REQUEST: 'TWO_SHORT', MANAGER: 'THREE_SHORT' },
    });
    const vibration = editorOf('pagers.vibration')!;
    expect(vibration.kind).toBe('RECORD');
    const empty = draftOf(vibration, {}) as Record<string, string>;
    expect(valueOf(vibration, { ...empty, ITEM_READY: 'TWO_SHORT' })).toEqual({
      ok: true,
      value: { ITEM_READY: 'TWO_SHORT' },
    });
    expect(editorOf('reco.dayparts')?.kind).toBe('FIELDS');
    expect(editorOf('auth.pinLength')).toEqual({ kind: 'CHOICE', options: [4, 6] });
    expect(valueOf(editorOf('auth.pinLength')!, '6')).toEqual({ ok: true, value: 6 });
    expect(editorOf('bills.printerId')?.kind).toBe('PRINTER');
    expect(editorOf('backups.secondLocation')).toEqual({ kind: 'TEXT', nullable: true });
    expect(valueOf(editorOf('backups.secondLocation')!, '  ')).toEqual({ ok: true, value: null });
  });

  it('groups by area, finds by words, and knows which need the Owner', () => {
    const settings = SETTINGS.map((setting) => settingView(setting.key));
    const all = groupSettings(settings, '', (setting) => setting.key);
    expect(all[0]?.area).toBe('auth');
    expect(all.map((group) => group.area)).toContain('kds');
    // `pager.*` and `pagers.*` are one area.
    expect(all.map((group) => group.area)).not.toContain('pager');
    expect(
      all.find((group) => group.area === 'pagers')?.settings.map((setting) => setting.key),
    ).toContain('pager.lowBatteryPercent');
    const found = groupSettings(settings, 'amber', (setting) =>
      t(`settingLabels.${setting.key as 'kds.ageAmberMinutes'}`),
    );
    expect(found.flatMap((group) => group.settings.map((setting) => setting.key))).toEqual([
      'kds.ageAmberMinutes',
    ]);
    expect(needsOwner(settingView('billing.priceMode'))).toBe(true);
    expect(needsOwner(settingView('kds.ageAmberMinutes'))).toBe(false);
  });
});
