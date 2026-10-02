import { describe, expect, it } from 'vitest';
import {
  markProblem,
  type OnboardingFacts,
  onboardingProgress,
  stepReady,
} from '../src/onboarding.js';

const NOTHING: OnboardingFacts = {
  profileComplete: false,
  taxGroups: 0,
  defaultInvoiceSeries: true,
  ownerHasSecondFactor: false,
  managers: 0,
  tables: 0,
  stations: 0,
  stationsWithoutWorkingPrinter: 0,
  menuItems: 0,
  menuPublished: false,
  staffWithPins: 0,
  pairedDevices: 0,
  tablesWithoutQr: 0,
};

const READY: OnboardingFacts = {
  ...NOTHING,
  profileComplete: true,
  taxGroups: 2,
  ownerHasSecondFactor: true,
  managers: 1,
  tables: 12,
  stations: 2,
  menuItems: 140,
  menuPublished: true,
  staffWithPins: 6,
  pairedDevices: 3,
};

describe('[ONB-004] the first-run setup', () => {
  it('starts with everything to do', () => {
    const progress = onboardingProgress(NOTHING, {});
    expect(progress.complete).toBe(false);
    expect(progress.steps.filter((entry) => entry.status === 'DONE')).toEqual([]);
  });

  it('counts a step done from the data, and the invoice look only once confirmed', () => {
    const progress = onboardingProgress(READY, {});
    expect(Object.fromEntries(progress.steps.map((entry) => [entry.step, entry.status]))).toEqual({
      PROFILE: 'DONE',
      TAX: 'DONE',
      INVOICE: 'TODO',
      ACCOUNTS: 'DONE',
      FLOOR: 'DONE',
      STATIONS: 'DONE',
      MENU: 'DONE',
      STAFF: 'DONE',
      DEVICES: 'DONE',
      QR: 'DONE',
      GO_LIVE: 'TODO',
    });
    expect(progress.steps.find((entry) => entry.step === 'GO_LIVE')?.ready).toBe(false);
  });

  it('lets a restaurant skip phones and QR ordering, then go live after the test', () => {
    const facts = { ...READY, pairedDevices: 0, tablesWithoutQr: 12 };
    const marks = { INVOICE: 'DONE', DEVICES: 'SKIPPED', QR: 'SKIPPED', GO_LIVE: 'DONE' } as const;
    const progress = onboardingProgress(facts, marks);
    expect(progress.complete).toBe(true);
    expect(progress.steps.find((entry) => entry.step === 'QR')?.status).toBe('SKIPPED');
    // A printer that never printed holds the stations step back, and so the go-live test.
    const printer = onboardingProgress({ ...facts, stationsWithoutWorkingPrinter: 1 }, marks);
    expect(printer.complete).toBe(false);
    expect(printer.steps.find((entry) => entry.step === 'GO_LIVE')?.status).toBe('TODO');
  });

  it('says which marks a person may make', () => {
    const progress = onboardingProgress(READY, {});
    expect(markProblem('QR', 'SKIPPED', progress)).toBeNull();
    expect(markProblem('MENU', 'SKIPPED', progress)).toBe('NOT_SKIPPABLE');
    expect(markProblem('MENU', 'DONE', progress)).toBe('NOT_CONFIRMABLE');
    expect(markProblem('INVOICE', 'DONE', progress)).toBeNull();
    expect(markProblem('GO_LIVE', 'DONE', progress)).toBe('NOT_READY');
    expect(stepReady('INVOICE', { ...READY, defaultInvoiceSeries: false })).toBe(false);
  });
});
