import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';
import { en } from '@rp/i18n';
import pg from 'pg';
import { e2eState } from './state.js';

/**
 * The QR menu on a phone (P5-05): a diner orders and follows the order while the test plays the
 * restaurant's local server at the relay; the menu turns read-only when the restaurant is gone;
 * an order nobody picks up says to call a waiter.
 */

const state = e2eState();
const s = en.qrSite;
const require = createRequire(import.meta.url);

/** The restaurant's local server at the relay, as P5-03 does it. */
async function asServer<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${state.relayUrl}/server/${path}`, {
    method,
    headers: { authorization: `Bearer ${state.credential}`, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path}: ${String(response.status)} ${await response.text()}`);
  return (await response.json()) as T;
}

async function relaySql(sql: string, params: unknown[] = []): Promise<void> {
  const client = new pg.Client({ connectionString: state.relayDatabaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(sql, params);
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
}

/** A dish's button in the menu itself (not in a suggestion row). */
const inMenu = (page: Page, name: string, section = 'Main Course') =>
  page.getByRole('region', { name: section }).getByRole('button', { name });

const tablePage = (page: Page, table = 'T1') =>
  page.goto(`${state.site}/t/${state.tokens[table] ?? ''}`);

async function expectAccessible(page: Page): Promise<void> {
  await page.addScriptTag({ content: readFileSync(require.resolve('axe-core'), 'utf8') });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: { run: () => Promise<{ violations: { id: string; impact: string }[] }> };
      }
    ).axe;
    const result = await axe.run();
    return result.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
  });
  expect(violations).toEqual([]);
}

test.describe('[QR-002] [QR-006] [QR-007] ordering from the table', () => {
  test('a diner finds a dish, orders it and follows the order to the kitchen', async ({ page }) => {
    await tablePage(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Spice Route' })).toBeVisible();
    await expect(page.getByText('Table T1')).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('searchbox', { name: s.search }).fill('dal');
    await inMenu(page, 'Add Dal Makhani', s.search).click();
    await page.getByRole('button', { name: /Your order · 1 item/ }).click();
    const cart = page.getByRole('dialog', { name: s.cart.title });
    await cart.getByLabel(s.cart.name).fill('Asha');
    await cart.getByRole('button', { name: s.cart.send }).click();
    await expect(page.getByText(s.orders.SUBMITTED)).toBeVisible();

    // The restaurant picks it up, then the waiter approves it.
    const { orders } = await asServer<{
      orders: { id: string; lines: { clientLineId: string }[] }[];
    }>('GET', 'orders');
    const order = orders.at(-1);
    if (order === undefined) throw new Error('nothing to pick up');
    await asServer('POST', `orders/${order.id}/status`, { status: 'RECEIVED' });
    await expect(page.getByText(s.orders.RECEIVED)).toBeVisible();
    await asServer('POST', `orders/${order.id}/status`, {
      status: 'SENT_TO_KITCHEN',
      detail: { items: [{ clientLineId: order.lines[0]?.clientLineId, state: 'PREPARING' }] },
    });
    await expect(page.getByText(s.orders.SENT_TO_KITCHEN)).toBeVisible();
    await expect(page.getByText(s.orders.itemState.PREPARING)).toBeVisible();
  });

  test('[MENU-012] a dish with sizes and extras is chosen as on every screen', async ({ page }) => {
    await tablePage(page, 'T2');
    await inMenu(page, 'Choose options for Paneer Tikka', 'Starters').click();
    const sheet = page.getByRole('dialog', { name: 'Paneer Tikka' });
    await sheet.getByRole('button', { name: /Add to order/ }).click();
    // A size must be chosen first (MENU-003).
    await expect(sheet).toBeVisible();
    await sheet.getByText('Half', { exact: true }).click();
    await sheet.getByText('Cheese', { exact: true }).click();
    await expect(sheet.getByRole('button', { name: 'Add to order · ₹220.00' })).toBeVisible();
    await sheet.getByRole('button', { name: /Add to order/ }).click();
    await page.getByRole('button', { name: /Your order · 1 item · ₹220.00/ }).click();
    await expect(
      page.getByRole('dialog', { name: s.cart.title }).getByText('Half · Cheese'),
    ).toBeVisible();
  });

  test('[QR-007] an order nobody picks up in time says to call a waiter', async ({ page }) => {
    await tablePage(page, 'T2');
    await inMenu(page, 'Add Dal Makhani').click();
    await page.getByRole('button', { name: /Your order/ }).click();
    await page
      .getByRole('dialog', { name: s.cart.title })
      .getByRole('button', { name: s.cart.send })
      .click();
    await expect(page.getByText(s.orders.SUBMITTED)).toBeVisible();
    await relaySql(
      "UPDATE relay.qr_orders SET expires_at = now() - interval '1 second' WHERE status = 'SUBMITTED'",
    );
    await expect(page.getByText(s.orders.EXPIRED)).toBeVisible();
  });
});

test.describe('[QR-004] suggestions', () => {
  test('suggests what goes with the cart, in the restaurant’s words, and counts it when ordered', async ({
    page,
  }) => {
    await tablePage(page, 'T2');
    await inMenu(page, 'Add Dal Makhani').click();
    const row = page.getByRole('region', { name: en.reco.row.cart });
    await expect(row.getByText('Sweet finish')).toBeVisible();
    await row.getByRole('button', { name: 'Add Rasmalai' }).click();
    await page.getByRole('button', { name: /Your order · 2 items/ }).click();
    await page
      .getByRole('dialog', { name: s.cart.title })
      .getByRole('button', { name: s.cart.send })
      .click();
    await expect(page.getByText(s.orders.SUBMITTED)).toBeVisible();
    const { orders } = await asServer<{
      orders: {
        lines: { itemId: string; recommendation?: { layer: string; ruleId: string | null } }[];
      }[];
    }>('GET', 'orders');
    const lines = orders.at(-1)?.lines ?? [];
    expect(lines.map((line) => line.recommendation?.layer ?? null)).toEqual([null, 'RULE']);
  });
});

test.describe('[QR-012] [NFR-P12] speed on a mid-range phone over 4G', () => {
  test('paints a 300-dish menu within 2.5 s', async ({ page, context }) => {
    // Lighthouse's mobile profile: Slow 4G (150 ms, 1.6 Mbps down, 750 kbps up) and a CPU four
    // times slower than this machine's.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const response = await tablePage(page, 'BIG');
    const html = (await response?.body())?.length ?? 0;
    const lcp = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          new PerformanceObserver((list) => {
            const entries = list.getEntries();
            resolve(entries.at(-1)?.startTime ?? Number.POSITIVE_INFINITY);
          }).observe({ type: 'largest-contentful-paint', buffered: true });
        }),
    );
    await expect(page.getByText('House dish number 300')).toBeAttached();
    // eslint-disable-next-line no-console -- the measured figures, for the CI log.
    console.log(`LCP ${String(Math.round(lcp))} ms, page ${String(Math.round(html / 1024))} kB`);
    expect(lcp).toBeLessThanOrEqual(2_500);
  });
});

test.describe('[QR-008] when the restaurant cannot be reached', () => {
  test('the menu stays readable and ordering pauses, with a banner', async ({ page }) => {
    await relaySql("UPDATE relay.presence SET last_seen_at = now() - interval '10 minutes'");
    await tablePage(page);
    await expect(page.getByText(s.readOnly)).toBeVisible();
    await expect(inMenu(page, 'Add Dal Makhani')).toBeDisabled();
    await expect(
      page.getByRole('region', { name: 'Main Course' }).getByText('Dal Makhani', { exact: true }),
    ).toBeVisible();
    await relaySql('UPDATE relay.presence SET last_seen_at = now()');
    await tablePage(page);
    await expect(page.getByText(s.readOnly)).toBeHidden();
    await expect(inMenu(page, 'Add Dal Makhani')).toBeEnabled();
  });
});

test.describe('[QR-001] [QR-013] the rest of the site', () => {
  test('a code that is not in use says so', async ({ page }) => {
    await page.goto(`${state.site}/t/AAAAAAAAAAAAAAAAAAAAAA`);
    await expect(page.getByRole('heading', { name: s.notFound.title })).toBeVisible();
  });

  test('links the privacy notice and the terms, and sends no referrer', async ({ page }) => {
    const response = await tablePage(page);
    expect(response?.headers()['referrer-policy']).toBe('no-referrer');
    expect(response?.headers()['content-security-policy']).toContain("default-src 'self'");
    await page.getByRole('link', { name: en.qrSite.footer.privacy }).click();
    await expect(page.getByRole('heading', { name: s.privacy.title })).toBeVisible();
    await page.goto(`${state.site}/terms`);
    await expect(page.getByRole('heading', { name: s.terms.title })).toBeVisible();
  });
});
