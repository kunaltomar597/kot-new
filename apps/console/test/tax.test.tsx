import type { InvoiceSeriesView, RestaurantProfile, TaxGroupView } from '@rp/contracts';
import type { Role } from '@rp/domain';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeResponse, FakeServer, RecordedCall } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { ownerSecurity, SECOND_FACTOR_REQUIRED } from './staff-fixture.js';
import {
  allSeries,
  bareProfile,
  DINE_IN,
  GST_5,
  GST_18,
  GSTIN,
  invoiceSeries,
  KARNATAKA_GSTIN,
  NEW_GROUP,
  NEW_SERIES,
  NIL_RATED,
  profile,
  restaurantChanged,
  TAKEAWAY,
  taxGroup,
  taxGroups,
} from './tax-fixture.js';

const PATH = '/manage/settings/tax';
const RESTAURANT = '/api/v1/restaurant';
const LEGAL = '/api/v1/restaurant/legal';
const TAX_GROUPS = '/api/v1/tax-groups';
const SERIES = '/api/v1/invoice-series';
/** 11:30 in the restaurant on 10 October 2026, in financial year 2026-27. */
const NOW = '2026-10-10T06:00:00.000Z';

interface TaxState {
  profile?: RestaurantProfile;
  taxGroups?: TaxGroupView[];
  series?: InvoiceSeriesView[];
}

/** The page's three reads, each answering what the test holds at the time. */
function taxServer(role: Role, state: TaxState = {}): FakeServer {
  return signsInAs(server(), role)
    .on('GET', RESTAURANT, () => ({ status: 200, body: state.profile ?? profile() }))
    .on('GET', TAX_GROUPS, () => ({
      status: 200,
      body: { taxGroups: state.taxGroups ?? taxGroups() },
    }))
    .on('GET', SERIES, () => ({
      status: 200,
      body: { invoiceSeries: state.series ?? allSeries() },
    }))
    .on('GET', '/api/v1/auth/owner/security', () => ({ status: 200, body: ownerSecurity() }))
    .on('POST', '/api/v1/auth/step-up', () => ({
      status: 200,
      body: { secondFactorValidUntil: '2026-10-10T06:10:00.000Z' },
    }));
}

/** The first try asks for the second factor; the one after it is answered. */
const afterSecondFactor = (answer: (call: RecordedCall) => FakeResponse) =>
  [() => SECOND_FACTOR_REQUIRED, answer] as const;

const refusal = (status: number, code: string, message: string): FakeResponse => ({
  status,
  body: { code, message },
});

/** `text` matched literally, followed by any hint. */
const labelled = (text: string) =>
  new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\*)?$`);
const sectionOf = (title: string) =>
  screen.getByRole('heading', { level: 3, name: title }).closest('section')!;
const factOf = (term: string) =>
  within(sectionOf(t('tax.legal.title'))).getByText(term, { selector: 'dt' })
    .nextElementSibling as HTMLElement;
const rowOf = (list: HTMLElement, name: string) =>
  within(list).getByRole('heading', { level: 4, name }).closest('li')!;
const headingsIn = (list: HTMLElement) =>
  within(list)
    .queryAllByRole('heading', { level: 4 })
    .map((heading) => heading.textContent);
const saveIn = (dialog: HTMLElement) =>
  within(dialog).getByRole('button', { name: t('settings.dialog.save') });
const bodiesOf = (fake: FakeServer, method: string, path: string) =>
  fake.callsTo(method, path).map((call) => call.body);

async function confirmSecondFactor(user: Awaited<ReturnType<typeof renderConsole>>['user']) {
  const confirm = await screen.findByRole('dialog', { name: t('secondFactor.title') });
  await user.type(
    await within(confirm).findByLabelText(labelled(t('secondFactor.password'))),
    'correct horse battery',
  );
  await user.type(within(confirm).getByLabelText(labelled(t('secondFactor.code'))), '123456');
  await user.click(within(confirm).getByRole('button', { name: t('secondFactor.confirm') }));
}

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('[MGR-007] [AUTH-006] the Tax and invoice page', () => {
  it('[BILL-002] [BILL-003] [BILL-004] shows a manager the particulars, tax groups and series, and that only the Owner changes them', async () => {
    const { container } = await renderConsole({
      fake: taxServer('MANAGER'),
      path: '/manage/settings',
      signedIn: 'MANAGER',
    });
    const pages = await screen.findByRole('navigation', { name: t('settings.pages.label') });
    within(pages)
      .getByRole('link', { name: t('settings.pages.tax') })
      .click();
    expect(await screen.findByRole('heading', { level: 2, name: t('tax.title') })).toBeVisible();
    expect(await screen.findByText(t('tax.ownerOnly'))).toBeVisible();
    await screen.findByText('Rooftop Foods Private Limited');
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ).toEqual([t('tax.legal.title'), t('tax.groups.title'), t('tax.series.title')]);

    expect(factOf(t('tax.legal.address'))).toHaveTextContent('14 Station Road, Pune 411001');
    expect(factOf(t('tax.legal.state'))).toHaveTextContent(
      t('tax.legal.stateValue', { name: 'Maharashtra', code: '27' }),
    );
    expect(factOf(t('tax.legal.gstin'))).toHaveTextContent(GSTIN);
    expect(factOf(t('tax.legal.fssai'))).toHaveTextContent('12345678901234');

    // Active groups only, each with its total, its taxes in print order and who uses it.
    const groups = sectionOf(t('tax.groups.title'));
    expect(headingsIn(groups)).toEqual(['GST 5 %', 'GST 18 %', 'Nil rated']);
    const gst5 = rowOf(groups, 'GST 5 %');
    expect(within(gst5).getByText('5 %')).toBeVisible();
    expect(within(gst5).getByText('CGST 2.5 % + SGST 2.5 %')).toBeVisible();
    expect(within(gst5).getByText(t('tax.groups.sac', { code: '996331' }))).toBeVisible();
    expect(within(gst5).getByText(t('tax.groups.items', { count: 24 }))).toBeVisible();
    expect(
      within(rowOf(groups, 'GST 18 %')).getByText(t('tax.groups.items', { count: 1 })),
    ).toBeVisible();
    const nil = rowOf(groups, 'Nil rated');
    expect(within(nil).getByText(t('tax.groups.noTax'))).toBeVisible();
    expect(within(nil).getByText(t('tax.groups.items', { count: 0 }))).toBeVisible();

    const series = sectionOf(t('tax.series.title'));
    expect(headingsIn(series)).toEqual(['Dine-in', 'Takeaway']);
    const dineIn = rowOf(series, 'Dine-in');
    expect(
      within(dineIn).getByText(t('tax.series.firstNumber', { example: 'INV/26-27/000001' })),
    ).toBeVisible();
    expect(within(dineIn).getByText(t('tax.series.default'))).toBeVisible();
    expect(within(dineIn).getByText(t('tax.series.yearly'))).toBeVisible();
    expect(within(dineIn).getByText(t('tax.series.invoices', { count: 1250 }))).toBeVisible();
    expect(
      within(rowOf(series, 'Takeaway')).getByText(t('tax.series.invoices', { count: 0 })),
    ).toBeVisible();

    // Nothing to press: no change, add or archive buttons.
    expect(screen.queryByRole('button', { name: t('tax.legal.changeLabel') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('tax.groups.add') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('tax.series.add') })).toBeNull();
    expect(screen.queryAllByRole('group', { name: /^Actions for/ })).toEqual([]);
    await expectNoAxeViolations(container);
  });

  it('shows the archived tax groups and series when asked', async () => {
    const { user } = await renderConsole({
      fake: taxServer('MANAGER'),
      path: PATH,
      signedIn: 'MANAGER',
    });
    await user.click(await screen.findByRole('checkbox', { name: t('tax.showArchived') }));
    const groups = sectionOf(t('tax.groups.title'));
    expect(headingsIn(groups)).toEqual(['GST 5 %', 'GST 18 %', 'Nil rated', 'GST 12 %']);
    expect(within(rowOf(groups, 'GST 12 %')).getByText(t('tax.archived'))).toBeVisible();
    const series = sectionOf(t('tax.series.title'));
    expect(headingsIn(series)).toEqual(['Dine-in', 'Takeaway', 'Party orders']);
    expect(within(rowOf(series, 'Party orders')).getByText(t('tax.archived'))).toBeVisible();
  });

  it('[BILL-002] says what is not given before the Owner enters the particulars', async () => {
    await renderConsole({
      fake: taxServer('OWNER', { profile: bareProfile(), taxGroups: [], series: [] }),
      path: PATH,
      signedIn: 'OWNER',
    });
    expect(await screen.findByText(t('tax.secondFactor'))).toBeVisible();
    await screen.findByText(t('tax.groups.none'));
    expect(factOf(t('tax.legal.legalName'))).toHaveTextContent(t('tax.legal.notGiven'));
    expect(factOf(t('tax.legal.address'))).toHaveTextContent(t('tax.legal.notGiven'));
    expect(factOf(t('tax.legal.state'))).toHaveTextContent(t('tax.legal.notGiven'));
    expect(factOf(t('tax.legal.gstin'))).toHaveTextContent(t('tax.legal.notRegistered'));
    expect(screen.getByText(t('tax.series.none'))).toBeVisible();
  });

  it('[BILL-002] lets the Owner change the invoice particulars after the second factor', async () => {
    const state: TaxState = {};
    const fake = taxServer('OWNER', state).on(
      'PUT',
      LEGAL,
      ...afterSecondFactor((call) => {
        const { reason: _reason, ...legal } = call.body as Record<string, unknown>;
        state.profile = { ...profile(), ...legal, stateName: 'Karnataka' };
        return { status: 200, body: state.profile };
      }),
    );
    const { user, container } = await renderConsole({ fake, path: PATH, signedIn: 'OWNER' });
    await user.click(await screen.findByRole('button', { name: t('tax.legal.changeLabel') }));
    const dialog = await screen.findByRole('dialog', { name: t('tax.legalDialog.title') });
    const field = (label: string) => within(dialog).getByLabelText(labelled(label));
    expect(field(t('tax.legalDialog.legalName'))).toHaveValue('Rooftop Foods Private Limited');
    await user.clear(field(t('tax.legalDialog.line1')));
    await user.type(field(t('tax.legalDialog.line1')), '2 Brigade Road');
    await user.type(field(t('tax.legalDialog.line2')), 'Second floor');
    await user.clear(field(t('tax.legalDialog.city')));
    await user.type(field(t('tax.legalDialog.city')), 'Bengaluru');
    await user.clear(field(t('tax.legalDialog.pincode')));
    await user.type(field(t('tax.legalDialog.pincode')), '560001');
    // A GSTIN from another state than the one chosen is refused before anything is sent.
    const gstin = field(t('tax.legalDialog.gstin'));
    await user.clear(gstin);
    await user.type(gstin, '29aaacb1234c1zb');
    await user.click(saveIn(dialog));
    expect(
      within(dialog).getByText(
        t('tax.legalDialog.problems.gstinOtherState', { code: '27', name: 'Maharashtra' }),
      ),
    ).toBeVisible();
    await user.selectOptions(
      field(t('tax.legalDialog.state')),
      t('tax.legal.stateValue', { name: 'Karnataka', code: '29' }),
    );
    await user.type(field(t('settings.dialog.reason')), 'Moved to Bengaluru');
    await expectNoAxeViolations(container);
    await user.click(saveIn(dialog));
    await confirmSecondFactor(user);

    expect(await screen.findByText(t('tax.legalDialog.saved'))).toBeVisible();
    const sent = {
      legalName: 'Rooftop Foods Private Limited',
      address: {
        line1: '2 Brigade Road',
        line2: 'Second floor',
        city: 'Bengaluru',
        pincode: '560001',
      },
      stateCode: '29',
      gstin: KARNATAKA_GSTIN,
      fssaiNumber: '12345678901234',
      reason: 'Moved to Bengaluru',
    };
    expect(bodiesOf(fake, 'PUT', LEGAL)).toEqual([sent, sent]);
    await waitFor(() => {
      expect(factOf(t('tax.legal.gstin'))).toHaveTextContent(KARNATAKA_GSTIN);
    });
    expect(factOf(t('tax.legal.address'))).toHaveTextContent(
      '2 Brigade Road, Second floor, Bengaluru 560001',
    );
  });

  it('[BILL-002] checks the GSTIN character by character, and takes the state from it', async () => {
    const fake = taxServer('OWNER', { profile: bareProfile() });
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'OWNER' });
    await user.click(await screen.findByRole('button', { name: t('tax.legal.changeLabel') }));
    const dialog = await screen.findByRole('dialog', { name: t('tax.legalDialog.title') });
    const field = (label: string) => within(dialog).getByLabelText(labelled(label));
    const gstin = field(t('tax.legalDialog.gstin'));
    await user.type(gstin, '27AAPFU0939F1ZW');
    // The state comes from the GSTIN's first two digits.
    expect(field(t('tax.legalDialog.state'))).toHaveValue('27');
    await user.click(saveIn(dialog));
    expect(within(dialog).getByText(t('tax.legalDialog.problems.gstinChecksum'))).toBeVisible();
    expect(within(dialog).getByText(t('tax.legalDialog.problems.legalName'))).toBeVisible();
    expect(within(dialog).getByText(t('tax.legalDialog.problems.pincode'))).toBeVisible();
    await user.clear(gstin);
    await user.type(gstin, '27AAPFU0939F1');
    expect(within(dialog).getByText(t('tax.legalDialog.problems.gstinFormat'))).toBeVisible();
    expect(bodiesOf(fake, 'PUT', LEGAL)).toEqual([]);
  });

  it('[BILL-004] lets the Owner add a tax group, its rates typed as percentages', async () => {
    const state: TaxState = {};
    const fake = taxServer('OWNER', state).on(
      'POST',
      TAX_GROUPS,
      ...afterSecondFactor((call) => {
        const body = call.body as { name: string; sacCode: string | null };
        const created = taxGroup({
          id: NEW_GROUP,
          name: body.name,
          sacCode: body.sacCode,
          components: [
            { code: 'CGST', rateBp: 1400 },
            { code: 'SGST', rateBp: 1400 },
            { code: 'CESS', rateBp: 1200 },
          ],
        });
        state.taxGroups = [...taxGroups(), created];
        return { status: 201, body: created };
      }),
    );
    const { user, container } = await renderConsole({ fake, path: PATH, signedIn: 'OWNER' });
    await user.click(await screen.findByRole('button', { name: t('tax.groups.add') }));
    const dialog = await screen.findByRole('dialog', { name: t('tax.groupDialog.addTitle') });
    const tax = (number: number) =>
      within(dialog).getByRole('group', { name: t('tax.groupDialog.taxLegend', { number }) });
    const rateOf = (number: number) =>
      within(tax(number)).getByLabelText(labelled(t('tax.groupDialog.rate')));
    expect(within(tax(1)).getByLabelText(labelled(t('tax.groupDialog.code')))).toHaveValue('CGST');
    expect(within(tax(2)).getByLabelText(labelled(t('tax.groupDialog.code')))).toHaveValue('SGST');
    expect(within(dialog).getByLabelText(labelled(t('tax.groupDialog.sac')))).toHaveValue('996331');

    await user.type(within(dialog).getByLabelText(labelled(t('tax.groupDialog.name'))), 'GST 5 %');
    await user.type(rateOf(1), '14');
    await user.type(rateOf(2), '14');
    expect(within(dialog).getByText(t('tax.groupDialog.total', { rate: '28' }))).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: t('tax.groupDialog.addTax') }));
    await user.type(within(tax(3)).getByLabelText(labelled(t('tax.groupDialog.code'))), 'cess');
    expect(within(tax(3)).getByLabelText(labelled(t('tax.groupDialog.code')))).toHaveValue('CESS');
    await user.type(rateOf(3), '12');
    await user.click(saveIn(dialog));
    // The name is taken by an active group.
    expect(within(dialog).getByText(t('tax.groupDialog.problems.nameTaken'))).toBeVisible();
    const name = within(dialog).getByLabelText(labelled(t('tax.groupDialog.name')));
    await user.clear(name);
    await user.type(name, 'Aerated drinks');
    expect(within(dialog).getByText(t('tax.groupDialog.total', { rate: '40' }))).toBeVisible();
    await expectNoAxeViolations(container);
    await user.click(saveIn(dialog));
    await confirmSecondFactor(user);

    expect(
      await screen.findByText(t('tax.groupDialog.saved', { name: 'Aerated drinks' })),
    ).toBeVisible();
    const sent = {
      name: 'Aerated drinks',
      sacCode: '996331',
      components: [
        { code: 'CGST', rateBp: 1400 },
        { code: 'SGST', rateBp: 1400 },
        { code: 'CESS', rateBp: 1200 },
      ],
    };
    expect(bodiesOf(fake, 'POST', TAX_GROUPS)).toEqual([sent, sent]);
    const groups = sectionOf(t('tax.groups.title'));
    await waitFor(() => {
      expect(headingsIn(groups)).toContain('Aerated drinks');
    });
    expect(
      within(rowOf(groups, 'Aerated drinks')).getByText('CGST 14 % + SGST 14 % + CESS 12 %'),
    ).toBeVisible();
  });

  it('[BILL-004] checks each tax and the total before sending', async () => {
    const fake = taxServer('OWNER');
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'OWNER' });
    await user.click(await screen.findByRole('button', { name: t('tax.groups.add') }));
    const dialog = await screen.findByRole('dialog', { name: t('tax.groupDialog.addTitle') });
    const tax = (number: number) =>
      within(dialog).getByRole('group', { name: t('tax.groupDialog.taxLegend', { number }) });
    await user.type(within(dialog).getByLabelText(labelled(t('tax.groupDialog.name'))), 'Odd');
    const sac = within(dialog).getByLabelText(labelled(t('tax.groupDialog.sac')));
    await user.clear(sac);
    await user.type(sac, '99');
    await user.type(within(tax(1)).getByLabelText(labelled(t('tax.groupDialog.rate'))), '60');
    await user.type(within(tax(2)).getByLabelText(labelled(t('tax.groupDialog.rate'))), '50');
    const secondCode = within(tax(2)).getByLabelText(labelled(t('tax.groupDialog.code')));
    await user.clear(secondCode);
    await user.type(secondCode, 'CGST');
    await user.click(saveIn(dialog));
    expect(within(dialog).getByText(t('tax.groupDialog.problems.sac'))).toBeVisible();
    expect(within(tax(2)).getByText(t('tax.groupDialog.problems.codeRepeated'))).toBeVisible();
    expect(within(dialog).getByText(t('tax.groupDialog.problems.total'))).toBeVisible();
    // A nil-rated group has no taxes at all.
    for (const number of [2, 1]) {
      await user.click(
        within(dialog).getByRole('button', {
          name: t('tax.groupDialog.removeLabel', { number }),
        }),
      );
    }
    expect(within(dialog).queryByRole('group', { name: /^Tax \d/ })).toBeNull();
    expect(within(dialog).getByText(t('tax.groupDialog.total', { rate: '0' }))).toBeVisible();
    expect(bodiesOf(fake, 'POST', TAX_GROUPS)).toEqual([]);
  });

  it('[BILL-004] changes a group menu items use, and shows the server’s refusal to archive one in use', async () => {
    const used = '1 menu item uses this tax group. Give it another tax group first.';
    const fake = taxServer('OWNER')
      .on(
        'PUT',
        `${TAX_GROUPS}/${GST_5}`,
        ...afterSecondFactor((call) => ({
          status: 200,
          body: taxGroup({ id: GST_5, ...(call.body as { name: string }), itemCount: 24 }),
        })),
      )
      .on('POST', `${TAX_GROUPS}/${GST_18}/archive`, () => refusal(409, 'TAX_GROUP_IN_USE', used));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'OWNER' });
    const actions = (name: string) =>
      screen.findByRole('group', { name: t('tax.groups.actionsFor', { name }) });
    await user.click(
      within(await actions('GST 5 %')).getByRole('button', { name: t('tax.groups.edit') }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: t('tax.groupDialog.editTitle', { name: 'GST 5 %' }),
    });
    expect(within(dialog).getByText(t('tax.groupDialog.inUse', { count: 24 }))).toBeVisible();
    const rates = within(dialog).getAllByLabelText(labelled(t('tax.groupDialog.rate')));
    expect(rates.map((input) => (input as HTMLInputElement).value)).toEqual(['2.5', '2.5']);
    const name = within(dialog).getByLabelText(labelled(t('tax.groupDialog.name')));
    await user.clear(name);
    await user.type(name, 'GST 5 % (food)');
    await user.click(saveIn(dialog));
    await confirmSecondFactor(user);
    expect(
      await screen.findByText(t('tax.groupDialog.saved', { name: 'GST 5 % (food)' })),
    ).toBeVisible();
    expect(bodiesOf(fake, 'PUT', `${TAX_GROUPS}/${GST_5}`)[1]).toEqual({
      name: 'GST 5 % (food)',
      sacCode: '996331',
      components: [
        { code: 'CGST', rateBp: 250 },
        { code: 'SGST', rateBp: 250 },
      ],
    });

    // The confirmation now holds, so archiving goes straight to the server, which refuses.
    await user.click(
      within(await actions('GST 18 %')).getByRole('button', { name: t('tax.groups.archive') }),
    );
    const archive = await screen.findByRole('dialog', {
      name: t('tax.archiveGroup.title', { name: 'GST 18 %' }),
    });
    await user.type(within(archive).getByRole('textbox'), 'Rates changed');
    await user.click(within(archive).getByRole('button', { name: t('tax.archiveGroup.confirm') }));
    expect(await within(archive).findByText(used)).toBeVisible();
    expect(bodiesOf(fake, 'POST', `${TAX_GROUPS}/${GST_18}/archive`)).toEqual([
      { reason: 'Rates changed' },
    ]);
  });

  it('[BILL-003] lets the Owner add a series, showing the first number as they type', async () => {
    const state: TaxState = {};
    const fake = taxServer('OWNER', state).on(
      'POST',
      SERIES,
      ...afterSecondFactor((call) => {
        const body = call.body as Omit<InvoiceSeriesView, 'id'>;
        const created = invoiceSeries({ ...body, id: NEW_SERIES });
        state.series = [...allSeries(), created];
        return { status: 201, body: created };
      }),
    );
    const { user, container } = await renderConsole({ fake, path: PATH, signedIn: 'OWNER' });
    await user.click(await screen.findByRole('button', { name: t('tax.series.add') }));
    const dialog = await screen.findByRole('dialog', { name: t('tax.seriesDialog.addTitle') });
    const field = (label: string) => within(dialog).getByLabelText(labelled(label));
    await user.type(field(t('tax.seriesDialog.name')), 'Delivery');
    expect(
      within(dialog).getByText(t('tax.seriesDialog.example', { example: '26-27/000001' })),
    ).toBeVisible();
    await user.type(field(t('tax.seriesDialog.prefix')), 'ta');
    // Capital letters as typed; an existing prefix is refused.
    expect(field(t('tax.seriesDialog.prefix'))).toHaveValue('TA');
    await user.click(saveIn(dialog));
    expect(within(dialog).getByText(t('tax.seriesDialog.problems.prefixTaken'))).toBeVisible();
    await user.clear(field(t('tax.seriesDialog.prefix')));
    await user.type(field(t('tax.seriesDialog.prefix')), 'PO');
    expect(within(dialog).getByText(t('tax.seriesDialog.problems.prefixRetired'))).toBeVisible();
    await user.clear(field(t('tax.seriesDialog.prefix')));
    await user.type(field(t('tax.seriesDialog.prefix')), 'DLVR');
    expect(within(dialog).getByText(t('tax.seriesDialog.problems.tooLong'))).toBeVisible();
    const digits = field(t('tax.seriesDialog.digits'));
    await user.clear(digits);
    await user.type(digits, '5');
    await user.click(
      within(dialog).getByRole('radio', { name: t('tax.seriesDialog.separators.DASH') }),
    );
    expect(
      within(dialog).getByText(t('tax.seriesDialog.example', { example: 'DLVR-26-27-00001' })),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('checkbox', { name: t('tax.seriesDialog.year') }));
    expect(
      within(dialog).getByText(t('tax.seriesDialog.example', { example: 'DLVR-00001' })),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('checkbox', { name: t('tax.seriesDialog.year') }));
    await expectNoAxeViolations(container);
    await user.click(saveIn(dialog));
    await confirmSecondFactor(user);

    expect(
      await screen.findByText(t('tax.seriesDialog.saved', { name: 'Delivery' })),
    ).toBeVisible();
    const sent = {
      name: 'Delivery',
      prefix: 'DLVR',
      includeFinancialYear: true,
      separator: '-',
      sequencePadding: 5,
    };
    expect(bodiesOf(fake, 'POST', SERIES)).toEqual([sent, sent]);
    const series = sectionOf(t('tax.series.title'));
    await waitFor(() => {
      expect(headingsIn(series)).toEqual(['Dine-in', 'Takeaway', 'Delivery']);
    });
    expect(
      within(rowOf(series, 'Delivery')).getByText(
        t('tax.series.firstNumber', { example: 'DLVR-26-27-00001' }),
      ),
    ).toBeVisible();
  });

  it('[BILL-003] keeps the format of a series that has issued invoices, and renames it', async () => {
    const fake = taxServer('OWNER').on(
      'PUT',
      `${SERIES}/${DINE_IN}`,
      ...afterSecondFactor((call) => ({
        status: 200,
        body: invoiceSeries({
          id: DINE_IN,
          ...(call.body as { name: string }),
          isDefault: true,
          invoiceCount: 1250,
        }),
      })),
    );
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'OWNER' });
    const actions = await screen.findByRole('group', {
      name: t('tax.series.actionsFor', { name: 'Dine-in' }),
    });
    // The default series is neither made the default nor archived.
    expect(
      within(actions)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([t('tax.series.edit')]);
    await user.click(within(actions).getByRole('button', { name: t('tax.series.edit') }));
    const dialog = await screen.findByRole('dialog', {
      name: t('tax.seriesDialog.editTitle', { name: 'Dine-in' }),
    });
    expect(within(dialog).getByText(t('tax.seriesDialog.fixed'))).toBeVisible();
    const field = (label: string) => within(dialog).getByLabelText(labelled(label));
    expect(field(t('tax.seriesDialog.prefix'))).toBeDisabled();
    expect(field(t('tax.seriesDialog.digits'))).toBeDisabled();
    expect(
      within(dialog).getByRole('checkbox', { name: t('tax.seriesDialog.year') }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole('radio', { name: t('tax.seriesDialog.separators.DASH') }),
    ).toBeDisabled();
    await user.clear(field(t('tax.seriesDialog.name')));
    await user.type(field(t('tax.seriesDialog.name')), 'Restaurant');
    await user.click(saveIn(dialog));
    await confirmSecondFactor(user);
    expect(
      await screen.findByText(t('tax.seriesDialog.saved', { name: 'Restaurant' })),
    ).toBeVisible();
    expect(bodiesOf(fake, 'PUT', `${SERIES}/${DINE_IN}`)[1]).toEqual({
      name: 'Restaurant',
      prefix: 'INV',
      includeFinancialYear: true,
      separator: '/',
      sequencePadding: 6,
    });
  });

  it('[BILL-003] lets the Owner make another series the default, and archive one', async () => {
    const state: TaxState = {};
    const fake = taxServer('OWNER', state)
      .on(
        'POST',
        `${SERIES}/${TAKEAWAY}/default`,
        ...afterSecondFactor(() => {
          state.series = allSeries().map((entry) => ({
            ...entry,
            isDefault: entry.id === TAKEAWAY,
          }));
          return { status: 200, body: state.series[1] };
        }),
      )
      .on('POST', `${SERIES}/${DINE_IN}/archive`, () => {
        state.series = (state.series ?? allSeries()).map((entry) =>
          entry.id === DINE_IN ? { ...entry, archivedAt: NOW } : entry,
        );
        return { status: 200, body: state.series[0] };
      });
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'OWNER' });
    const actions = (name: string) =>
      screen.findByRole('group', { name: t('tax.series.actionsFor', { name }) });
    await user.click(
      within(await actions('Takeaway')).getByRole('button', { name: t('tax.series.makeDefault') }),
    );
    const confirm = await screen.findByRole('dialog', {
      name: t('tax.defaultDialog.title', { name: 'Takeaway' }),
    });
    expect(
      within(confirm).getByText(
        t('tax.defaultDialog.description', { name: 'Takeaway', example: 'TA/26-27/000001' }),
      ),
    ).toBeVisible();
    await user.click(within(confirm).getByRole('button', { name: t('tax.defaultDialog.confirm') }));
    await confirmSecondFactor(user);
    expect(
      await screen.findByText(t('tax.series.defaultToast', { name: 'Takeaway' })),
    ).toBeVisible();
    const series = sectionOf(t('tax.series.title'));
    await waitFor(() => {
      expect(within(rowOf(series, 'Takeaway')).getByText(t('tax.series.default'))).toBeVisible();
    });

    // Dine-in is no longer the default, so it can be archived, with a reason.
    await user.click(
      within(await actions('Dine-in')).getByRole('button', { name: t('tax.series.archive') }),
    );
    const archive = await screen.findByRole('dialog', {
      name: t('tax.archiveSeries.title', { name: 'Dine-in' }),
    });
    await user.type(within(archive).getByRole('textbox'), 'One series for all bills');
    await user.click(within(archive).getByRole('button', { name: t('tax.archiveSeries.confirm') }));
    expect(
      await screen.findByText(t('tax.series.archivedToast', { name: 'Dine-in' })),
    ).toBeVisible();
    await waitFor(() => {
      expect(headingsIn(series)).toEqual(['Takeaway']);
    });
    expect(bodiesOf(fake, 'POST', `${SERIES}/${DINE_IN}/archive`)).toEqual([
      { reason: 'One series for all bills' },
    ]);
  });

  it('[AUTH-006] leaves the dialog as it was when the Owner closes the second factor', async () => {
    const fake = taxServer('OWNER').on('POST', `${TAX_GROUPS}/${NIL_RATED}/archive`, () => ({
      ...SECOND_FACTOR_REQUIRED,
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'OWNER' });
    await user.click(
      within(
        await screen.findByRole('group', {
          name: t('tax.groups.actionsFor', { name: 'Nil rated' }),
        }),
      ).getByRole('button', { name: t('tax.groups.archive') }),
    );
    const archive = await screen.findByRole('dialog', {
      name: t('tax.archiveGroup.title', { name: 'Nil rated' }),
    });
    await user.type(within(archive).getByRole('textbox'), 'Not needed');
    await user.click(within(archive).getByRole('button', { name: t('tax.archiveGroup.confirm') }));
    const confirm = await screen.findByRole('dialog', { name: t('secondFactor.title') });
    await user.click(within(confirm).getByRole('button', { name: t('secondFactor.cancel') }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: t('secondFactor.title') })).toBeNull();
    });
    expect(within(archive).queryByRole('alert')).toBeNull();
    expect(within(archive).getByRole('textbox')).toHaveValue('Not needed');
    expect(
      within(archive).getByRole('button', { name: t('tax.archiveGroup.confirm') }),
    ).toBeEnabled();
  });

  it('follows changes made on another screen', async () => {
    const state: TaxState = {};
    const { sockets } = await renderConsole({
      fake: taxServer('MANAGER', state),
      path: PATH,
      signedIn: 'MANAGER',
    });
    const groups = await waitFor(() => sectionOf(t('tax.groups.title')));
    await waitFor(() => {
      expect(headingsIn(groups)).toEqual(['GST 5 %', 'GST 18 %', 'Nil rated']);
    });
    state.taxGroups = taxGroups().filter((group) => group.id !== NIL_RATED);
    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', restaurantChanged(1, 'TAX_GROUPS'));
    });
    await waitFor(() => {
      expect(headingsIn(groups)).toEqual(['GST 5 %', 'GST 18 %']);
    });
  });

  it('says when the settings cannot be read, and reads them again', async () => {
    const fake = taxServer('MANAGER').on(
      'GET',
      TAX_GROUPS,
      () => refusal(500, 'INTERNAL', 'Something went wrong.'),
      () => ({ status: 200, body: { taxGroups: taxGroups() } }),
    );
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    expect(await screen.findByText(t('tax.loadFailed'))).toBeVisible();
    await user.click(screen.getByRole('button', { name: t('states.retry') }));
    expect(await screen.findByText('Rooftop Foods Private Limited')).toBeVisible();
  });
});
