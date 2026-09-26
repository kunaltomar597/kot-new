import { expect, type Page, test } from '@playwright/test';
import { createTranslator } from '@rp/i18n';
import { type RunningServer, startServer } from './server.js';

/**
 * P0-14b acceptance: a real browser pairs with the real server, people sign in with their PIN and
 * land in their mode, and the offline banner shows while the server is down (NFR-P11).
 */

const t = createTranslator();

/** People from the development seed (apps/server/src/database/dev-seed.ts). */
const PEOPLE = [
  { name: 'Asha (Owner)', role: 'OWNER', pin: '1111', mode: 'manage' },
  { name: 'Vikram (Manager)', role: 'MANAGER', pin: '2222', mode: 'manage' },
  { name: 'Neha (Cashier)', role: 'CASHIER', pin: '3333', mode: 'pos' },
  { name: 'Ravi', role: 'WAITER', pin: '4444', mode: 'pos' },
  { name: 'Chef Imran', role: 'KITCHEN', pin: '6666', mode: 'kds' },
] as const;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test.describe.serial('the web console', () => {
  let server: RunningServer;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    server = await startServer();
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
    await server.stop();
  });

  test('[AUTH-007] [AUTH-004] [MGR-001] [KDS-001] pairs, signs each role in by PIN and lands in the right mode', async () => {
    const bootstrap = await fetch(`${server.url}/api/v1/devices/pairing-codes/bootstrap`, {
      method: 'POST',
    });
    expect(bootstrap.status).toBe(201);
    const { code } = (await bootstrap.json()) as { code: string };

    await page.goto(server.url);
    await expect(page).toHaveURL(/\/pair$/);
    await page.getByLabel(t('pairing.codeLabel')).fill(code.toLowerCase().replace('-', ' '));
    await page.getByRole('button', { name: t('pairing.submit') }).click();
    await expect(page.getByRole('heading', { name: t('login.title') })).toBeVisible();

    for (const person of PEOPLE) {
      await page.getByRole('button', { name: new RegExp(`^${escape(person.name)}`) }).click();
      await expect(
        page.getByRole('heading', { name: t('login.pinFor', { name: person.name }) }),
      ).toBeVisible();
      await page.keyboard.type(person.pin);
      await expect(page).toHaveURL(new RegExp(`/${person.mode}$`));
      await expect(
        page.getByRole('heading', { level: 1, name: t(`modes.${person.mode}`) }),
      ).toBeVisible();
      await expect(
        page.getByText(
          t('modes.signedInAs', { name: person.name, role: t(`roles.${person.role}`) }),
        ),
      ).toBeVisible();
      await page.getByRole('button', { name: t('login.signOut') }).click();
      await expect(page.getByRole('heading', { name: t('login.title') })).toBeVisible();
    }
  });

  test('[NFR-P11] shows the offline banner while the server is down and recovers when it is back', async () => {
    await page.getByRole('button', { name: /^Neha \(Cashier\)/ }).click();
    await page.keyboard.type('3333');
    await expect(page).toHaveURL(/\/pos$/);
    // Connected and in sync: no banner.
    await expect(page.getByText(t('connection.connecting'))).toHaveCount(0);

    await server.stop();
    await expect(page.getByRole('alert')).toContainText(t('connection.offline'));

    const started = Date.now();
    server = await startServer(server.port);
    await expect(page.getByText(t('connection.offline'))).toHaveCount(0, { timeout: 30_000 });
    expect(Date.now() - started).toBeLessThan(30_000);
    // Still signed in: the session survived the restart.
    await expect(page.getByRole('heading', { level: 1, name: t('modes.pos') })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: t('modes.pos') })).toBeVisible();
  });

  test('[TBL-007] [TBL-003] [TBL-005] opens a table and moves it on the POS floor', async () => {
    await expect(page).toHaveURL(/\/pos$/);
    const hall = page.getByRole('region', { name: 'Main Hall' });
    await expect(hall.getByRole('button', { name: '1, Free' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Terrace' })).toBeVisible();

    await hall.getByRole('button', { name: '1, Free' }).click();
    const open = page.getByRole('dialog', { name: t('pos.open.title', { table: '1' }) });
    await open.getByLabel(t('pos.open.guests'), { exact: true }).fill('2');
    await open.getByRole('button', { name: t('pos.open.submit') }).click();
    await expect(page.getByText(t('pos.open.opened', { table: '1' }))).toBeVisible();
    const occupied = hall.getByRole('button', { name: /^1, Occupied, 2 guests, 0 min, / });
    await expect(occupied).toBeVisible();

    await occupied.click();
    const details = page.getByRole('dialog', { name: t('pos.table.title', { table: '1' }) });
    await details.getByRole('button', { name: t('pos.table.move') }).click();
    const move = page.getByRole('dialog', { name: t('pos.move.title', { table: '1' }) });
    await move.getByRole('button', { name: '7, Free' }).click();
    await expect(page.getByText(t('pos.move.moved', { from: '1', to: '7' }))).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: 'Terrace' })
        .getByRole('button', { name: /^7, Occupied, 2 guests/ }),
    ).toBeVisible();
    await expect(hall.getByRole('button', { name: '1, Free' })).toBeVisible();
  });
});
