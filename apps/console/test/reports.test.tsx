import { businessDateOf } from '@rp/domain';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeServer } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import {
  discountReport,
  kitchenReport,
  ORDER_ID,
  orderDrillDown,
  registerPage,
  salesReport,
  suggestionReport,
} from './reports-fixture.js';
import { profileView } from './restaurant-fixture.js';

const TODAY = businessDateOf(new Date(), { cutoff: '04:00', timeZone: 'Asia/Kolkata' });

function rangeOf(path: string): { from: string; to: string } {
  const query = new URL(`http://x${path}`).searchParams;
  return { from: query.get('from') ?? '', to: query.get('to') ?? '' };
}

function reportsServer(): FakeServer {
  return signsInAs(server(), 'MANAGER')
    .on('GET', '/api/v1/restaurant', () => ({ status: 200, body: profileView() }))
    .on('GET', '/api/v1/reports/sales', (call) => {
      const { from, to } = rangeOf(call.path);
      return { status: 200, body: salesReport(from, to) };
    })
    .on('GET', '/api/v1/reports/discounts', (call) => {
      const { from, to } = rangeOf(call.path);
      return { status: 200, body: discountReport(from, to) };
    })
    .on('GET', '/api/v1/reports/invoice-register', (call) => {
      const { from, to } = rangeOf(call.path);
      const offset = Number(new URL(`http://x${call.path}`).searchParams.get('offset') ?? 0);
      return { status: 200, body: registerPage(from, to, offset) };
    })
    .on('GET', '/api/v1/reports/kitchen', (call) => {
      const { from, to } = rangeOf(call.path);
      return { status: 200, body: kitchenReport(from, to) };
    })
    .on('GET', '/api/v1/reports/recommendations', (call) => {
      const { from, to } = rangeOf(call.path);
      return { status: 200, body: suggestionReport(from, to) };
    })
    .on('GET', `/api/v1/reports/orders/${ORDER_ID}`, () => ({
      status: 200,
      body: orderDrillDown(),
    }))
    .on('POST', '/api/v1/reports/exports', () => ({
      status: 200,
      body: {
        filename: `sales_${TODAY}_${TODAY}.csv`,
        contentType: 'text/csv; charset=utf-8',
        content: 'Restaurant,Spice Route\n',
        generatedAt: '2026-10-01T10:00:00.000Z',
      },
    }));
}

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[RPT-016] the Reports area', () => {
  it('opens on today’s sales with the headline figures, chart and tables', async () => {
    const fake = reportsServer();
    const { container, user } = await renderConsole({
      fake,
      path: '/manage',
      signedIn: 'MANAGER',
    });
    await user.click(
      within(screen.getByRole('navigation', { name: t('dashboard.navigation') })).getByRole(
        'link',
        { name: t('dashboard.section.reports') },
      ),
    );
    expect(
      await screen.findByRole('heading', { level: 3, name: t('reportsPage.report.sales') }),
    ).toBeVisible();
    expect(fake.callsTo('GET', `/api/v1/reports/sales?from=${TODAY}&to=${TODAY}`)).toHaveLength(1);
    expect(screen.getAllByText('₹1,234.56').length).toBeGreaterThan(0);
    // One day: the chart is by hour.
    expect(screen.getByText(t('reportsPage.sales.chartByHour'))).toBeVisible();
    expect(screen.getByRole('button', { name: t('reportsPage.range.today') })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expectNoAxeViolations(container);
  });

  it('reads every report again for another period, kept in the address', async () => {
    const fake = reportsServer();
    const { user } = await renderConsole({ fake, path: '/manage/reports', signedIn: 'MANAGER' });
    await screen.findByRole('heading', { level: 3, name: t('reportsPage.report.sales') });
    await user.click(screen.getByRole('button', { name: t('reportsPage.range.last7') }));
    const week = await waitFor(() => {
      const call = fake.calls.find(
        (entry) =>
          entry.path.startsWith('/api/v1/reports/sales') && !entry.path.includes(`from=${TODAY}`),
      );
      expect(call).toBeDefined();
      return rangeOf(call?.path ?? '');
    });
    expect(week.to).toBe(TODAY);
    expect(await screen.findByText(t('reportsPage.sales.chartByDay'))).toBeVisible();

    // The same period follows to another report.
    await user.click(screen.getByRole('link', { name: t('reportsPage.report.discounts') }));
    expect(
      await screen.findByRole('heading', { level: 3, name: t('reportsPage.report.discounts') }),
    ).toBeVisible();
    expect(
      fake.callsTo('GET', `/api/v1/reports/discounts?from=${week.from}&to=${week.to}`),
    ).toHaveLength(1);

    // A custom range the server would refuse is caught first.
    const from = screen.getByLabelText(t('reportsPage.range.from'));
    await user.clear(from);
    await user.type(from, '2020-01-01');
    await user.click(screen.getByRole('button', { name: t('reportsPage.range.show') }));
    expect(screen.getByText(t('reportsPage.range.problems.TOO_LONG'))).toBeVisible();
  });

  it('[RPT-007] [RPT-015] lists a free dish with who and why, and opens its order', async () => {
    const { user } = await renderConsole({
      fake: reportsServer(),
      path: `/manage/reports/discounts?from=${TODAY}&to=${TODAY}`,
      signedIn: 'MANAGER',
    });
    const table = within(
      await screen.findByRole('table', { name: t('reportsPage.discounts.table') }),
    );
    expect(table.getByText(t('reportsPage.discounts.free'))).toBeVisible();
    expect(table.getByText('Birthday')).toBeVisible();
    await user.click(table.getByRole('link', { name: t('reportsPage.openOrder') }));
    expect(
      await screen.findByRole('heading', {
        level: 3,
        name: t('reportsPage.order.title', { number: 42 }),
      }),
    ).toBeVisible();
    expect(screen.getByText(t('reportsPage.order.table', { table: 'T4' }))).toBeVisible();
    expect(screen.getByRole('table', { name: t('reportsPage.order.items') })).toBeVisible();
  });

  it('[RPT-017] exports a report as CSV', async () => {
    const createObjectURL = vi.fn(() => 'blob:report');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const fake = reportsServer();
    const { user } = await renderConsole({
      fake,
      path: `/manage/reports/sales?from=${TODAY}&to=${TODAY}`,
      signedIn: 'MANAGER',
    });
    await user.click(await screen.findByRole('button', { name: t('reportsPage.export') }));
    expect(
      await screen.findByText(t('reportsPage.exported', { file: `sales_${TODAY}_${TODAY}.csv` })),
    ).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/reports/exports')[0]?.body).toEqual({
      report: 'SALES',
      from: TODAY,
      to: TODAY,
      format: 'CSV',
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });
});

describe('[RPT-006] [RPT-018] the invoice register', () => {
  it('shows the whole range’s counts and reads more invoices a page at a time', async () => {
    const fake = reportsServer();
    const { user } = await renderConsole({
      fake,
      path: `/manage/reports/register?from=${TODAY}&to=${TODAY}`,
      signedIn: 'MANAGER',
    });
    const table = await screen.findByRole('table', { name: t('reportsPage.register.table') });
    expect(within(table).getAllByRole('row')).toHaveLength(201);
    expect(screen.getByText('250')).toBeVisible();
    expect(
      screen.getByText(t('reportsPage.register.showing', { shown: 200, total: 250 })),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: t('reportsPage.register.more') }));
    await waitFor(() => {
      expect(within(table).getAllByRole('row')).toHaveLength(251);
    });
    expect(
      fake.callsTo(
        'GET',
        `/api/v1/reports/invoice-register?from=${TODAY}&to=${TODAY}&offset=200&limit=200`,
      ),
    ).toHaveLength(1);
    expect(screen.queryByRole('button', { name: t('reportsPage.register.more') })).toBeNull();
  });
});

describe('[RPT-010] [RPT-012] operations reports', () => {
  it('shows kitchen times and suggestion figures', async () => {
    const { user, container } = await renderConsole({
      fake: reportsServer(),
      path: `/manage/reports/kitchen?from=${TODAY}&to=${TODAY}`,
      signedIn: 'MANAGER',
    });
    expect(
      await screen.findByRole('table', { name: t('reportsPage.kitchen.stations') }),
    ).toBeVisible();
    expect(
      screen.getAllByText(t('reportsPage.duration.minutesSeconds', { minutes: 12, seconds: 30 }))
        .length,
    ).toBeGreaterThan(0);
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('link', { name: t('reportsPage.report.suggestions') }));
    expect(
      await screen.findByRole('table', { name: t('reportsPage.suggestions.layers') }),
    ).toBeVisible();
    expect(screen.getAllByText('15%').length).toBeGreaterThan(0);
    expect(
      screen.getByText(t('reportsPage.suggestions.ordersValue', { withSuggestion: 5, orders: 30 })),
    ).toBeVisible();
  });
});
