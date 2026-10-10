import type { RestaurantProfile } from '@rp/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeServer, RecordedCall } from './fake-server.js';
import { login } from './fakes.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { bareProfile, LOGO, NEW_LOGO, profile, restaurantChanged, week } from './tax-fixture.js';

const PATH = '/manage/settings/restaurant';
const RESTAURANT = '/api/v1/restaurant';
const PROFILE = '/api/v1/restaurant/profile';
/** 11:30 in the restaurant on 10 October 2026. */
const NOW = '2026-10-10T06:00:00.000Z';

const PHOTO = {
  id: NEW_LOGO,
  mimeType: 'image/webp',
  width: 480,
  height: 240,
  renditions: [{ width: 160, height: 80, bytes: 3_000, url: `/api/v1/photos/${NEW_LOGO}/160` }],
  createdAt: NOW,
};

/** A fake server holding the profile: a saved change is read back from then on. */
function restaurantServer(initial: RestaurantProfile = profile()): FakeServer {
  let current = initial;
  const save = (call: RecordedCall) => {
    const { reason: _reason, ...request } = call.body as Record<string, unknown>;
    current = { ...current, ...(request as Partial<RestaurantProfile>) };
    return { status: 200, body: current };
  };
  return signsInAs(server(), 'MANAGER')
    .on('GET', RESTAURANT, () => ({ status: 200, body: current }))
    .on('PUT', PROFILE, save);
}

/** `text` matched literally, followed by any hint. */
const labelled = (text: string) =>
  new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\*)?$`);
const partOf = (title: string) =>
  screen.getByRole('heading', { level: 3, name: title }).closest('section')!;
const factOf = (part: HTMLElement, term: string) =>
  within(part).getByText(term, { selector: 'dt' }).nextElementSibling as HTMLElement;
const putsTo = (fake: FakeServer) => fake.callsTo('PUT', PROFILE).map((call) => call.body);
const saveIn = (dialog: HTMLElement) =>
  within(dialog).getByRole('button', { name: t('settings.dialog.save') });

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('[ONB-004] [MGR-007] the Restaurant page', () => {
  it('shows the name, contact details, logo, opening hours and when the business day ends', async () => {
    const { container } = await renderConsole({
      fake: restaurantServer(),
      path: '/manage/settings',
      signedIn: 'MANAGER',
    });
    const pages = await screen.findByRole('navigation', { name: t('settings.pages.label') });
    within(pages)
      .getByRole('link', { name: t('settings.pages.restaurant') })
      .click();
    expect(
      await screen.findByRole('heading', { level: 2, name: t('restaurant.title') }),
    ).toBeVisible();
    await screen.findByText('Rooftop Tandoor');
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ).toEqual([
      t('restaurant.contact.title'),
      t('restaurant.hours.title'),
      t('restaurant.businessDay.title'),
    ]);

    const contact = partOf(t('restaurant.contact.title'));
    expect(factOf(contact, t('restaurant.contact.name'))).toHaveTextContent('Rooftop Tandoor');
    expect(factOf(contact, t('restaurant.contact.phone'))).toHaveTextContent('+91 20 2612 3456');
    expect(factOf(contact, t('restaurant.contact.email'))).toHaveTextContent(
      'hello@rooftop.example',
    );
    expect(
      within(contact).getByRole('img', {
        name: t('restaurant.contact.logoAlt', { name: 'Rooftop Tandoor' }),
      }),
    ).toHaveAttribute('src', `http://pos.test/api/v1/photos/${LOGO}/480`);

    // Lunch and dinner, past midnight at the weekend, closed on Sunday.
    const hours = partOf(t('restaurant.hours.title'));
    const lunch = t('restaurant.hours.window', { start: '12:00', end: '15:30' });
    expect(factOf(hours, t('restaurant.days.MON'))).toHaveTextContent(
      `${lunch}, ${t('restaurant.hours.window', { start: '19:00', end: '23:30' })}`,
    );
    expect(factOf(hours, t('restaurant.days.FRI'))).toHaveTextContent(
      `${lunch}, ${t('restaurant.hours.windowOvernight', { start: '19:00', end: '01:00' })}`,
    );
    expect(factOf(hours, t('restaurant.days.SUN'))).toHaveTextContent(t('restaurant.hours.closed'));
    expect(
      factOf(partOf(t('restaurant.businessDay.title')), t('restaurant.businessDay.endsAt')),
    ).toHaveTextContent('04:00');

    for (const label of [
      t('restaurant.contact.changeLabel'),
      t('restaurant.hours.changeLabel'),
      t('restaurant.businessDay.changeLabel'),
    ]) {
      expect(screen.getByRole('button', { name: label })).toHaveTextContent(t('restaurant.change'));
    }
    await expectNoAxeViolations(container);
  });

  it('says what is not given yet', async () => {
    await renderConsole({
      fake: restaurantServer(bareProfile()),
      path: PATH,
      signedIn: 'MANAGER',
    });
    await screen.findByText('Rooftop Tandoor');
    const contact = partOf(t('restaurant.contact.title'));
    expect(factOf(contact, t('restaurant.contact.phone'))).toHaveTextContent(
      t('restaurant.notGiven'),
    );
    expect(factOf(contact, t('restaurant.contact.logo'))).toHaveTextContent(
      t('restaurant.contact.noLogo'),
    );
    const hours = partOf(t('restaurant.hours.title'));
    expect(within(hours).getAllByText(t('restaurant.hours.closed'))).toHaveLength(7);
  });

  it('changes the name and the phone, uploads a new logo and keeps the reason', async () => {
    const fake = restaurantServer().on('POST', '/api/v1/photos', () => ({
      status: 201,
      body: PHOTO,
    }));
    const { user, container } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      await screen.findByRole('button', { name: t('restaurant.contact.changeLabel') }),
    );
    const dialog = await screen.findByRole('dialog', { name: t('restaurant.contactDialog.title') });
    const name = within(dialog).getByLabelText(labelled(t('restaurant.contactDialog.name')));
    expect(name).toHaveValue('Rooftop Tandoor');
    await user.clear(name);
    await user.type(name, 'Rooftop Tandoor and Bar');
    const phone = within(dialog).getByLabelText(labelled(t('restaurant.contactDialog.phone')));
    await user.clear(phone);
    await user.type(phone, '020-2612-9999');
    await user.clear(within(dialog).getByLabelText(labelled(t('restaurant.contactDialog.email'))));
    await user.upload(
      within(dialog).getByLabelText(t('restaurant.contactDialog.logo')),
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', { type: 'image/png' }),
    );
    expect(
      await within(dialog).findByRole('img', {
        name: t('restaurant.contact.logoAlt', { name: 'Rooftop Tandoor and Bar' }),
      }),
    ).toHaveAttribute('src', `http://pos.test/api/v1/photos/${NEW_LOGO}/480`);
    expect(fake.callsTo('POST', '/api/v1/photos')[0]?.body).toEqual({ contentBase64: 'iVBORw==' });
    await user.type(
      within(dialog).getByLabelText(labelled(t('settings.dialog.reason'))),
      'New sign board',
    );
    await expectNoAxeViolations(container);
    await user.click(saveIn(dialog));

    expect(await screen.findByText(t('restaurant.contactDialog.saved'))).toBeVisible();
    expect(putsTo(fake)).toEqual([
      {
        displayName: 'Rooftop Tandoor and Bar',
        contact: { phone: '020-2612-9999', email: null },
        businessHours: week(),
        logoPhotoId: NEW_LOGO,
        businessDayCutoff: '04:00',
        reason: 'New sign board',
      },
    ]);
    const contact = partOf(t('restaurant.contact.title'));
    await waitFor(() => {
      expect(factOf(contact, t('restaurant.contact.name'))).toHaveTextContent(
        'Rooftop Tandoor and Bar',
      );
    });
    expect(factOf(contact, t('restaurant.contact.email'))).toHaveTextContent(
      t('restaurant.notGiven'),
    );
  });

  it('asks for a name, a phone number and an email address that are right, and a longer reason', async () => {
    const fake = restaurantServer();
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      await screen.findByRole('button', { name: t('restaurant.contact.changeLabel') }),
    );
    const dialog = await screen.findByRole('dialog', { name: t('restaurant.contactDialog.title') });
    await user.clear(within(dialog).getByLabelText(labelled(t('restaurant.contactDialog.name'))));
    const phone = within(dialog).getByLabelText(labelled(t('restaurant.contactDialog.phone')));
    await user.clear(phone);
    await user.type(phone, '12345');
    const email = within(dialog).getByLabelText(labelled(t('restaurant.contactDialog.email')));
    await user.clear(email);
    await user.type(email, 'desk@');
    await user.type(within(dialog).getByLabelText(labelled(t('settings.dialog.reason'))), 'ok');
    await user.click(saveIn(dialog));
    for (const problem of [
      t('restaurant.contactDialog.problems.nameRequired'),
      t('restaurant.contactDialog.problems.phone'),
      t('restaurant.contactDialog.problems.email'),
      t('settings.dialog.reasonShort'),
    ]) {
      expect(within(dialog).getByText(problem)).toBeVisible();
    }
    expect(putsTo(fake)).toEqual([]);
  });

  it('[AUTH-012] lets people who cannot manage the menu remove the logo but not upload one', async () => {
    // A manager whose custom role does not manage the menu still keeps the profile up to date.
    const configurer = login('MANAGER');
    const fake = restaurantServer().on('POST', '/api/v1/auth/pin-login', () => ({
      status: 200,
      body: {
        ...configurer,
        staff: {
          ...configurer.staff,
          customRole: {
            id: '0199a0e0-0000-7000-8000-000000000c01',
            name: 'Front of house lead',
            added: [],
            removed: ['MENU_MANAGE'],
          },
        },
      },
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      await screen.findByRole('button', { name: t('restaurant.contact.changeLabel') }),
    );
    const dialog = await screen.findByRole('dialog', { name: t('restaurant.contactDialog.title') });
    expect(within(dialog).getByText(t('restaurant.contactDialog.logoNeedsMenu'))).toBeVisible();
    expect(
      within(dialog).queryByRole('button', { name: t('restaurant.contactDialog.replaceLogo') }),
    ).toBeNull();
    await user.click(
      within(dialog).getByRole('button', { name: t('restaurant.contactDialog.removeLogo') }),
    );
    expect(within(dialog).getByText(t('restaurant.contact.noLogo'))).toBeVisible();
    await user.click(saveIn(dialog));
    await screen.findByText(t('restaurant.contactDialog.saved'));
    expect(putsTo(fake)).toMatchObject([{ logoPhotoId: null }]);
  });

  it('changes the opening hours: Monday’s hours every day, Sunday closed, late on Saturday', async () => {
    const fake = restaurantServer(profile({ businessHours: [] }));
    const { user, container } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      await screen.findByRole('button', { name: t('restaurant.hours.changeLabel') }),
    );
    const dialog = await screen.findByRole('dialog', { name: t('restaurant.hoursDialog.title') });
    expect(within(dialog).getAllByText(t('restaurant.hoursDialog.closed'))).toHaveLength(7);
    const monday = t('restaurant.days.MON');
    const windowOf = (day: string, number: number) =>
      within(dialog).getByRole('group', {
        name: t('restaurant.hoursDialog.hoursLegend', { day, number }),
      });
    const fill = async (day: string, number: number, start: string, end: string) => {
      const group = windowOf(day, number);
      await user.type(
        within(group).getByLabelText(labelled(t('restaurant.hoursDialog.opens'))),
        start,
      );
      await user.type(
        within(group).getByLabelText(labelled(t('restaurant.hoursDialog.closes'))),
        end,
      );
    };
    const add = (day: string) =>
      user.click(
        within(dialog).getByRole('button', { name: t('restaurant.hoursDialog.addLabel', { day }) }),
      );

    await add(monday);
    await fill(monday, 1, '12:00', '15:30');
    await add(monday);
    await fill(monday, 2, '19:00', '23:30');
    await user.click(
      within(dialog).getByRole('button', {
        name: t('restaurant.hoursDialog.copy', { day: monday }),
      }),
    );
    const sunday = t('restaurant.days.SUN');
    for (const number of [2, 1]) {
      await user.click(
        within(dialog).getByRole('button', {
          name: t('restaurant.hoursDialog.removeLabel', { day: sunday, number }),
        }),
      );
    }
    // Saturday's dinner runs past midnight.
    const saturday = t('restaurant.days.SAT');
    const late = within(windowOf(saturday, 2)).getByLabelText(
      labelled(t('restaurant.hoursDialog.closes')),
    );
    await user.clear(late);
    await user.type(late, '01:00');
    expect(
      within(windowOf(saturday, 2)).getByText(t('restaurant.hoursDialog.overnight')),
    ).toBeVisible();
    await expectNoAxeViolations(container);
    await user.click(saveIn(dialog));

    expect(await screen.findByText(t('restaurant.hoursDialog.saved'))).toBeVisible();
    const lunchAndDinner = (day: string, end = '23:30') => [
      { day, start: '12:00', end: '15:30' },
      { day, start: '19:00', end },
    ];
    expect(putsTo(fake)).toEqual([
      {
        displayName: 'Rooftop Tandoor',
        contact: profile().contact,
        businessHours: [
          ...lunchAndDinner('MON'),
          ...lunchAndDinner('TUE'),
          ...lunchAndDinner('WED'),
          ...lunchAndDinner('THU'),
          ...lunchAndDinner('FRI'),
          ...lunchAndDinner('SAT', '01:00'),
        ],
        logoPhotoId: LOGO,
        businessDayCutoff: '04:00',
      },
    ]);
  });

  it('asks for both times of a window, and different ones', async () => {
    const fake = restaurantServer(profile({ businessHours: [] }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      await screen.findByRole('button', { name: t('restaurant.hours.changeLabel') }),
    );
    const dialog = await screen.findByRole('dialog', { name: t('restaurant.hoursDialog.title') });
    const tuesday = t('restaurant.days.TUE');
    const addTuesday = within(dialog).getByRole('button', {
      name: t('restaurant.hoursDialog.addLabel', { day: tuesday }),
    });
    await user.click(addTuesday);
    await user.click(addTuesday);
    const second = within(dialog).getByRole('group', {
      name: t('restaurant.hoursDialog.hoursLegend', { day: tuesday, number: 2 }),
    });
    await user.type(
      within(second).getByLabelText(labelled(t('restaurant.hoursDialog.opens'))),
      '18:00',
    );
    await user.type(
      within(second).getByLabelText(labelled(t('restaurant.hoursDialog.closes'))),
      '18:00',
    );
    await user.click(saveIn(dialog));
    expect(within(dialog).getByText(t('restaurant.hoursDialog.problems.time'))).toBeVisible();
    expect(within(second).getByText(t('restaurant.hoursDialog.problems.same'))).toBeVisible();
    // Four windows a day at most.
    await user.click(addTuesday);
    await user.click(addTuesday);
    expect(addTuesday).toBeDisabled();
    expect(putsTo(fake)).toEqual([]);
  });

  it('changes when the business day ends, and shows the server’s refusal in the dialog', async () => {
    const refusal =
      'Changing the cut-off now would move the business date. Change it later in the day, after both the old and the new cut-off time.';
    const fake = restaurantServer().on(
      'PUT',
      PROFILE,
      () => ({
        status: 409,
        body: { code: 'CUTOFF_WOULD_MOVE_BUSINESS_DATE', message: refusal },
      }),
      (call) => ({ status: 200, body: { ...profile(), ...(call.body as object) } }),
    );
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      await screen.findByRole('button', { name: t('restaurant.businessDay.changeLabel') }),
    );
    const dialog = await screen.findByRole('dialog', { name: t('restaurant.cutoffDialog.title') });
    const time = within(dialog).getByLabelText(labelled(t('restaurant.cutoffDialog.time')));
    expect(time).toHaveValue('04:00');
    await user.clear(time);
    await user.type(time, '13:00');
    await user.click(saveIn(dialog));
    expect(within(dialog).getByText(t('restaurant.cutoffDialog.problems.morning'))).toBeVisible();

    await user.clear(time);
    await user.type(time, '05:00');
    await user.click(saveIn(dialog));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(refusal);
    await user.click(saveIn(dialog));
    expect(
      await screen.findByText(t('restaurant.cutoffDialog.saved', { time: '05:00' })),
    ).toBeVisible();
    expect(putsTo(fake)).toMatchObject([
      { businessDayCutoff: '05:00' },
      { businessDayCutoff: '05:00' },
    ]);
  });

  it('follows changes made on another screen', async () => {
    let name = 'Rooftop Tandoor';
    const fake = signsInAs(server(), 'MANAGER').on('GET', RESTAURANT, () => ({
      status: 200,
      body: profile({ displayName: name }),
    }));
    const { sockets } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await screen.findByText('Rooftop Tandoor');
    name = 'Rooftop Tandoor Koregaon Park';
    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', restaurantChanged(1, 'PROFILE'));
    });
    expect(await screen.findByText('Rooftop Tandoor Koregaon Park')).toBeVisible();
  });

  it('says when the restaurant cannot be read, and reads it again', async () => {
    const fake = signsInAs(server(), 'MANAGER').on(
      'GET',
      RESTAURANT,
      () => ({ status: 500, body: { code: 'INTERNAL', message: 'Something went wrong.' } }),
      () => ({ status: 200, body: profile() }),
    );
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    expect(await screen.findByText(t('restaurant.loadFailed'))).toBeVisible();
    await user.click(screen.getByRole('button', { name: t('states.retry') }));
    expect(await screen.findByText('Rooftop Tandoor')).toBeVisible();
  });
});
