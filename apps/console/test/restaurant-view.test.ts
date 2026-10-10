import { describe, expect, it } from 'vitest';
import {
  businessHoursOf,
  checkContact,
  checkCutoff,
  type ContactForm,
  contactChangeOf,
  contactFormOf,
  copyHours,
  hoursAreValid,
  hoursFormOf,
  isOvernight,
  profileRequestOf,
  reasonProblemOf,
  WEEKDAYS,
  windowProblemOf,
} from '../src/manage/settings/restaurant-view.js';
import { bareProfile, LOGO, NEW_LOGO, profile, week } from './tax-fixture.js';

describe('[ONB-004] [MGR-007] the name, contact and logo', () => {
  const form = (overrides: Partial<ContactForm> = {}): ContactForm => ({
    ...contactFormOf(profile()),
    ...overrides,
  });

  it('fills the form from the profile, and leaves out what is not given', () => {
    expect(contactFormOf(profile())).toEqual({
      displayName: 'Rooftop Tandoor',
      phone: '+91 20 2612 3456',
      email: 'hello@rooftop.example',
      logoPhotoId: LOGO,
    });
    expect(contactFormOf(bareProfile())).toEqual({
      displayName: 'Rooftop Tandoor',
      phone: '',
      email: '',
      logoPhotoId: null,
    });
  });

  it('asks for a name, and for a phone number and an email address only when they are given', () => {
    expect(checkContact(form())).toEqual({});
    expect(checkContact(form({ displayName: '  ' }))).toEqual({ displayName: 'nameRequired' });
    expect(checkContact(form({ displayName: 'x'.repeat(61) }))).toEqual({
      displayName: 'nameRequired',
    });
    expect(checkContact(form({ phone: '', email: '' }))).toEqual({});
    expect(checkContact(form({ phone: '020-2612-3456' }))).toEqual({});
    expect(checkContact(form({ phone: ' 9876543210 ' }))).toEqual({});
    expect(checkContact(form({ phone: '12345' }))).toEqual({ phone: 'phone' });
    expect(checkContact(form({ phone: 'call the desk' }))).toEqual({ phone: 'phone' });
    expect(checkContact(form({ email: ' desk@rooftop.example ' }))).toEqual({});
    expect(checkContact(form({ email: 'desk@' }))).toEqual({ email: 'email' });
  });

  it('sends the whole profile: the contact trimmed, nothing given as none, the rest as saved', () => {
    const change = contactChangeOf(
      form({ displayName: ' Rooftop ', phone: ' ', email: '', logoPhotoId: NEW_LOGO }),
    );
    expect(profileRequestOf(profile(), change, '')).toEqual({
      displayName: 'Rooftop',
      contact: { phone: null, email: null },
      businessHours: week(),
      logoPhotoId: NEW_LOGO,
      businessDayCutoff: '04:00',
    });
    expect(profileRequestOf(profile(), { businessDayCutoff: '05:00' }, ' Later close ')).toEqual({
      displayName: 'Rooftop Tandoor',
      contact: { phone: '+91 20 2612 3456', email: 'hello@rooftop.example' },
      businessHours: week(),
      logoPhotoId: LOGO,
      businessDayCutoff: '05:00',
      reason: 'Later close',
    });
  });

  it('[AUD-001] takes no reason, or one of at least 3 characters', () => {
    expect(reasonProblemOf('')).toBeUndefined();
    expect(reasonProblemOf('   ')).toBeUndefined();
    expect(reasonProblemOf(' ok ')).toBe('reasonShort');
    expect(reasonProblemOf('New number')).toBeUndefined();
  });
});

describe('[ONB-004] the opening hours', () => {
  it('reads the week day by day, earliest first; a day without hours is closed', () => {
    const form = hoursFormOf([
      { day: 'MON', start: '19:00', end: '23:30' },
      { day: 'MON', start: '12:00', end: '15:30' },
      { day: 'FRI', start: '19:00', end: '01:00' },
    ]);
    expect(Object.keys(form)).toEqual([...WEEKDAYS]);
    expect(form.MON).toEqual([
      { start: '12:00', end: '15:30' },
      { start: '19:00', end: '23:30' },
    ]);
    expect(form.SUN).toEqual([]);
    expect(isOvernight({ start: '19:00', end: '01:00' })).toBe(true);
    expect(isOvernight({ start: '12:00', end: '15:30' })).toBe(false);
  });

  it('needs both times, and different ones', () => {
    expect(windowProblemOf({ start: '12:00', end: '15:30' })).toBeUndefined();
    expect(windowProblemOf({ start: '19:00', end: '01:00' })).toBeUndefined();
    expect(windowProblemOf({ start: '', end: '15:30' })).toBe('time');
    expect(windowProblemOf({ start: '12:00', end: '25:00' })).toBe('time');
    expect(windowProblemOf({ start: '12:00', end: '12:00' })).toBe('same');
    const form = hoursFormOf(week());
    expect(hoursAreValid(form)).toBe(true);
    expect(hoursAreValid({ ...form, SUN: [{ start: '11:00', end: '' }] })).toBe(false);
  });

  it('gives one day’s hours to every day, and sends the week day by day', () => {
    const form = { ...hoursFormOf([]), WED: [{ start: '18:00', end: '23:00' }] };
    const copied = copyHours(form, 'WED');
    for (const day of WEEKDAYS) expect(copied[day]).toEqual([{ start: '18:00', end: '23:00' }]);
    // Each day has its own copy.
    expect(copied.MON).not.toBe(copied.TUE);
    expect(businessHoursOf(hoursFormOf(week()))).toEqual(week());
    expect(
      businessHoursOf({
        ...hoursFormOf([]),
        SUN: [{ start: '09:00', end: '11:00' }],
        MON: [
          { start: '19:00', end: '23:00' },
          { start: '12:00', end: '15:00' },
        ],
      }),
    ).toEqual([
      { day: 'MON', start: '12:00', end: '15:00' },
      { day: 'MON', start: '19:00', end: '23:00' },
      { day: 'SUN', start: '09:00', end: '11:00' },
    ]);
  });
});

describe('[ONB-004] when the business day ends', () => {
  it('takes a time in the morning, before 12:00', () => {
    expect(checkCutoff('04:00')).toBeUndefined();
    expect(checkCutoff('11:59')).toBeUndefined();
    expect(checkCutoff('00:00')).toBeUndefined();
    expect(checkCutoff('12:00')).toBe('morning');
    expect(checkCutoff('23:00')).toBe('morning');
    expect(checkCutoff('')).toBe('time');
    expect(checkCutoff('4')).toBe('time');
  });
});
