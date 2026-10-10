import {
  BusinessDayCutoff,
  type OpeningHours,
  PhoneNumber,
  RestaurantContact,
  type RestaurantProfile,
  TimeOfDay,
  UpdateRestaurantProfileRequest,
  type Weekday,
} from '@rp/contracts';

/**
 * The Restaurant page's logic (P4-03e, ONB-004 step 1, MGR-007), without React: the profile a
 * manager keeps up to date (the name guests and staff see, the phone and email, the logo, the
 * opening hours and when the business day ends) and its forms, with the same checks as the server.
 * The route takes the whole profile, so each form changes its part of what is saved.
 */

export const WEEKDAYS: readonly Weekday[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
/** Lunch, dinner and room for more: four a day fill the week's 28 the route takes. */
export const WINDOWS_PER_DAY = 4;

/** An optional reason for the audit log (AUD-001): none, or at least 3 characters. */
export function reasonProblemOf(reason: string): 'reasonShort' | undefined {
  const length = reason.trim().length;
  return length === 0 || length >= 3 ? undefined : 'reasonShort';
}

// ---------------------------------------------------------------- name, contact and logo

export interface ContactForm {
  readonly displayName: string;
  readonly phone: string;
  readonly email: string;
  /** A photo from the photo store, or none. */
  readonly logoPhotoId: string | null;
}

export type ContactField = 'displayName' | 'phone' | 'email';
export type ContactProblem = 'nameRequired' | 'phone' | 'email';

export function contactFormOf(profile: RestaurantProfile): ContactForm {
  return {
    displayName: profile.displayName,
    phone: profile.contact.phone ?? '',
    email: profile.contact.email ?? '',
    logoPhotoId: profile.logoPhotoId,
  };
}

/** The server's checks: a name, and a phone number and an email address when they are given. */
export function checkContact(form: ContactForm): Partial<Record<ContactField, ContactProblem>> {
  const problems: Partial<Record<ContactField, ContactProblem>> = {};
  if (!UpdateRestaurantProfileRequest.shape.displayName.safeParse(form.displayName).success) {
    problems.displayName = 'nameRequired';
  }
  if (form.phone.trim() !== '' && !PhoneNumber.safeParse(form.phone).success) {
    problems.phone = 'phone';
  }
  const email = form.email.trim();
  if (email !== '' && !RestaurantContact.shape.email.safeParse(email).success) {
    problems.email = 'email';
  }
  return problems;
}

// ---------------------------------------------------------------- opening hours

export interface HoursWindow {
  readonly start: string;
  readonly end: string;
}

/** Each day's opening hours, earliest first; a day without any is closed. */
export type HoursForm = Readonly<Record<Weekday, readonly HoursWindow[]>>;

export type WindowProblem = 'time' | 'same';

const byStart = (a: HoursWindow, b: HoursWindow) => a.start.localeCompare(b.start);

export function hoursFormOf(hours: readonly OpeningHours[]): HoursForm {
  return Object.fromEntries(
    WEEKDAYS.map((day) => [
      day,
      hours
        .filter((window) => window.day === day)
        .map(({ start, end }) => ({ start, end }))
        .sort(byStart),
    ]),
  ) as Record<Weekday, HoursWindow[]>;
}

/** Whether a window closes after midnight (it ends before it starts). */
export function isOvernight(window: HoursWindow): boolean {
  return window.end < window.start;
}

/** A time each, and opening and closing times that differ (the route's checks). */
export function windowProblemOf(window: HoursWindow): WindowProblem | undefined {
  if (!TimeOfDay.safeParse(window.start).success || !TimeOfDay.safeParse(window.end).success) {
    return 'time';
  }
  return window.start === window.end ? 'same' : undefined;
}

/** Whether every window of the week can be saved. */
export function hoursAreValid(form: HoursForm): boolean {
  return WEEKDAYS.every((day) =>
    form[day].every((window) => windowProblemOf(window) === undefined),
  );
}

/** One day's hours given to every day: most restaurants keep the same hours all week. */
export function copyHours(form: HoursForm, from: Weekday): HoursForm {
  return Object.fromEntries(
    WEEKDAYS.map((day) => [day, form[from].map((window) => ({ ...window }))]),
  ) as Record<Weekday, HoursWindow[]>;
}

/** The week as the route takes it: day by day, earliest first. */
export function businessHoursOf(form: HoursForm): OpeningHours[] {
  return WEEKDAYS.flatMap((day) =>
    [...form[day]].sort(byStart).map((window) => ({ day, ...window })),
  );
}

// ---------------------------------------------------------------- business day

export type CutoffProblem = 'time' | 'morning';

/** A time, and in the morning: sales after midnight belong to the day before (BRD §9.4). */
export function checkCutoff(text: string): CutoffProblem | undefined {
  if (!TimeOfDay.safeParse(text).success) return 'time';
  return BusinessDayCutoff.safeParse(text).success ? undefined : 'morning';
}

// ---------------------------------------------------------------- the request

export type ProfileChange = Partial<
  Pick<
    UpdateRestaurantProfileRequest,
    'displayName' | 'contact' | 'businessHours' | 'logoPhotoId' | 'businessDayCutoff'
  >
>;

export function contactChangeOf(form: ContactForm): ProfileChange {
  const phone = form.phone.trim();
  const email = form.email.trim();
  return {
    displayName: form.displayName.trim(),
    contact: { phone: phone === '' ? null : phone, email: email === '' ? null : email },
    logoPhotoId: form.logoPhotoId,
  };
}

/** The whole profile as the route takes it: what is saved, with one part changed. */
export function profileRequestOf(
  profile: RestaurantProfile,
  change: ProfileChange,
  reason: string,
): UpdateRestaurantProfileRequest {
  const why = reason.trim();
  return {
    displayName: profile.displayName,
    contact: profile.contact,
    businessHours: profile.businessHours,
    logoPhotoId: profile.logoPhotoId,
    businessDayCutoff: profile.businessDayCutoff,
    ...change,
    ...(why !== '' && { reason: why }),
  };
}
