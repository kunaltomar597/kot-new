import type { OnboardingResponse, OnboardingStep } from '@rp/contracts';

/** Where each step is done (ONB-004): the page that already does it. */
export const STEP_PAGES: Readonly<Record<OnboardingStep, string>> = {
  PROFILE: '/manage/restaurant',
  TAX: '/manage/restaurant',
  INVOICE: '/manage/restaurant',
  ACCOUNTS: '/manage/staff',
  FLOOR: '/manage/floor',
  STATIONS: '/manage/printing',
  MENU: '/manage/menu',
  STAFF: '/manage/staff',
  DEVICES: '/manage/devices',
  QR: '/manage/qr-codes',
  GO_LIVE: '/pos',
};

/** Steps done or skipped, out of all. */
export function setupCounts(view: OnboardingResponse): { finished: number; total: number } {
  return {
    finished: view.steps.filter((entry) => entry.status !== 'TODO').length,
    total: view.steps.length,
  };
}

/** The first step still to do: where "Continue" goes. */
export function nextStep(view: OnboardingResponse): OnboardingStep | null {
  return view.steps.find((entry) => entry.status === 'TODO')?.step ?? null;
}
