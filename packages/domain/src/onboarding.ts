/**
 * The first-run setup (ONB-004, P7-07): its 11 steps, and whether each is done, from what the
 * restaurant has set up and what a person confirmed or skipped. Pure, so the server and the
 * console agree.
 */

export const ONBOARDING_STEPS = [
  'PROFILE',
  'TAX',
  'INVOICE',
  'ACCOUNTS',
  'FLOOR',
  'STATIONS',
  'MENU',
  'STAFF',
  'DEVICES',
  'QR',
  'GO_LIVE',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Steps a person must confirm, beyond what the data shows: the invoice look, the go-live test. */
export const CONFIRMED_STEPS: readonly OnboardingStep[] = ['INVOICE', 'GO_LIVE'];
/** Steps a restaurant may skip: it may use no phones or tablets, or no QR ordering. */
export const SKIPPABLE_STEPS: readonly OnboardingStep[] = ['DEVICES', 'QR'];

export type OnboardingMark = 'DONE' | 'SKIPPED';
export type OnboardingStatus = 'DONE' | 'SKIPPED' | 'TODO';

/** What the restaurant has, counted on the server. */
export interface OnboardingFacts {
  /** Legal name, address, state and opening hours entered. */
  readonly profileComplete: boolean;
  readonly taxGroups: number;
  readonly defaultInvoiceSeries: boolean;
  /** The Owner has a password and a confirmed authenticator (AUTH-006). */
  readonly ownerHasSecondFactor: boolean;
  readonly managers: number;
  readonly tables: number;
  readonly stations: number;
  /** Stations that print (or print and show) without a printer that has printed yet. */
  readonly stationsWithoutWorkingPrinter: number;
  readonly menuItems: number;
  readonly menuPublished: boolean;
  /** Waiters, cashiers and kitchen staff with a PIN. */
  readonly staffWithPins: number;
  /** Phones, tablets, kitchen screens and pagers paired (not this console). */
  readonly pairedDevices: number;
  /** Tables whose QR table tent code was never issued. */
  readonly tablesWithoutQr: number;
}

/** Whether the data says a step is done (before confirmations and skips). */
export function stepReady(step: OnboardingStep, facts: OnboardingFacts): boolean {
  switch (step) {
    case 'PROFILE':
      return facts.profileComplete;
    case 'TAX':
      return facts.taxGroups > 0;
    case 'INVOICE':
      return facts.defaultInvoiceSeries;
    case 'ACCOUNTS':
      return facts.ownerHasSecondFactor && facts.managers > 0;
    case 'FLOOR':
      return facts.tables > 0;
    case 'STATIONS':
      return facts.stations > 0 && facts.stationsWithoutWorkingPrinter === 0;
    case 'MENU':
      return facts.menuItems > 0 && facts.menuPublished;
    case 'STAFF':
      return facts.staffWithPins > 0;
    case 'DEVICES':
      return facts.pairedDevices > 0;
    case 'QR':
      return facts.tables > 0 && facts.tablesWithoutQr === 0;
    case 'GO_LIVE':
      return true;
  }
}

export interface OnboardingProgress {
  readonly steps: readonly { step: OnboardingStep; status: OnboardingStatus; ready: boolean }[];
  /** Every step done or skipped: the restaurant is ready to go live. */
  readonly complete: boolean;
}

/**
 * Each step's status: done when the data shows it (and, for a confirmed step, a person
 * confirmed it), skipped when a person skipped a skippable step, otherwise to do. The go-live
 * test counts only once every other step is done or skipped.
 */
export function onboardingProgress(
  facts: OnboardingFacts,
  marks: Readonly<Partial<Record<OnboardingStep, OnboardingMark>>>,
): OnboardingProgress {
  const statusOf = (step: OnboardingStep): OnboardingStatus => {
    const ready = stepReady(step, facts);
    if (ready && (!CONFIRMED_STEPS.includes(step) || marks[step] === 'DONE')) return 'DONE';
    if (SKIPPABLE_STEPS.includes(step) && marks[step] === 'SKIPPED') return 'SKIPPED';
    return 'TODO';
  };
  const before = ONBOARDING_STEPS.filter((step) => step !== 'GO_LIVE').map((step) => ({
    step,
    status: statusOf(step),
    ready: stepReady(step, facts),
  }));
  const othersFinished = before.every((entry) => entry.status !== 'TODO');
  const goLive: OnboardingStatus = othersFinished && marks.GO_LIVE === 'DONE' ? 'DONE' : 'TODO';
  const steps = [...before, { step: 'GO_LIVE' as const, status: goLive, ready: othersFinished }];
  return { steps, complete: steps.every((entry) => entry.status !== 'TODO') };
}

/** Why a person may not mark a step so, or null when they may. */
export function markProblem(
  step: OnboardingStep,
  mark: OnboardingMark,
  progress: OnboardingProgress,
): 'NOT_SKIPPABLE' | 'NOT_CONFIRMABLE' | 'NOT_READY' | null {
  if (mark === 'SKIPPED') return SKIPPABLE_STEPS.includes(step) ? null : 'NOT_SKIPPABLE';
  if (!CONFIRMED_STEPS.includes(step)) return 'NOT_CONFIRMABLE';
  const entry = progress.steps.find((candidate) => candidate.step === step);
  return entry?.ready === true ? null : 'NOT_READY';
}
