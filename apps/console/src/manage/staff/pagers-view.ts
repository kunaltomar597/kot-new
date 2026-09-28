import { CreatePagerRequest, type PagerView, type StaffView } from '@rp/contracts';
import { pagerWarning } from '@rp/domain';

/** Pagers (P4-02b, PGR-012 to PGR-014): the register form and what a pager's row says. */

export interface PagerForm {
  readonly serial: string;
  readonly name: string;
  /** Empty for nobody yet. */
  readonly staffId: string;
}

export type PagerField = 'serial' | 'name';
export type PagerProblem = 'serialInvalid' | 'nameRequired';

/** "Pager N" with the first number no pager uses, so registering at shift start is quick. */
export function suggestedName(
  pagers: readonly PagerView[],
  nameFor: (number: number) => string,
): string {
  const taken = new Set(pagers.map((pager) => pager.name.trim().toLowerCase()));
  let number = 1;
  while (taken.has(nameFor(number).toLowerCase())) number += 1;
  return nameFor(number);
}

/** The same checks as the server: a serial of 4 to 32 letters, digits or dashes, and a name. */
export function checkPager(form: PagerForm): Partial<Record<PagerField, PagerProblem>> {
  const problems: Partial<Record<PagerField, PagerProblem>> = {};
  if (!CreatePagerRequest.shape.serial.safeParse(form.serial).success) {
    problems.serial = 'serialInvalid';
  }
  if (!CreatePagerRequest.shape.name.safeParse(form.name).success) problems.name = 'nameRequired';
  return problems;
}

export function createPagerRequestOf(form: PagerForm): CreatePagerRequest {
  return {
    serial: form.serial.trim(),
    name: form.name.trim(),
    staffId: form.staffId === '' ? null : form.staffId,
  };
}

/** A pager's state in words, never in colour alone (PGR-013). */
export type PagerState =
  | { readonly kind: 'CONNECTED' }
  | { readonly kind: 'NOT_CONNECTED'; readonly lastSeenAt: string | null };

export type BatteryState =
  { readonly kind: 'UNKNOWN' } | { readonly kind: 'OK' | 'LOW'; readonly percent: number };

export function pagerStateOf(pager: PagerView): PagerState {
  return pager.online
    ? { kind: 'CONNECTED' }
    : { kind: 'NOT_CONNECTED', lastSeenAt: pager.lastSeenAt };
}

export function batteryOf(pager: PagerView, lowBatteryPercent: number): BatteryState {
  if (pager.batteryPercent === null) return { kind: 'UNKNOWN' };
  // The same rule as the pager itself and the wearer's phone (PGR-013 ⚙).
  const low = pagerWarning({ ...pager, online: true }, lowBatteryPercent) === 'LOW_BATTERY';
  return { kind: low ? 'LOW' : 'OK', percent: pager.batteryPercent };
}

/** Who may be given a pager: anyone active (managers wear one for escalations, PGR-014), by name. */
export function wearersFor(people: readonly StaffView[], pager?: PagerView): StaffView[] {
  return people
    .filter((person) => person.active && person.id !== pager?.staffId)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
