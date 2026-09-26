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

  test('[ORD-001] [MENU-012] [ORD-010] orders at a table with a variant, modifier and combo', async () => {
    await page
      .getByRole('region', { name: 'Terrace' })
      .getByRole('button', { name: /^7, Occupied/ })
      .click();
    await page.getByRole('button', { name: t('pos.table.takeOrder') }).click();
    await expect(
      page.getByRole('heading', { name: t('pos.table.title', { table: '7' }) }),
    ).toBeVisible();

    await page.getByRole('button', { name: /^Chicken Tikka, / }).click();
    const tikka = page.getByRole('dialog', { name: 'Chicken Tikka' });
    await tikka.getByRole('radio', { name: /Full/ }).check();
    await tikka.getByRole('radio', { name: 'Medium' }).check();
    await tikka.getByRole('button', { name: t('pos.item.add') }).click();

    await page.getByRole('button', { name: 'Combos', exact: true }).click();
    await page.getByRole('button', { name: /^Veg Thali Combo, / }).click();
    const thali = page.getByRole('dialog', { name: 'Veg Thali Combo' });
    await thali.getByRole('radio', { name: 'Rasmalai' }).check();
    await thali.getByRole('button', { name: t('pos.item.add') }).click();

    const cart = page.getByRole('complementary', { name: t('pos.cart.title') });
    await expect(cart.getByText('Full · Medium')).toBeVisible();
    await expect(cart.getByText('Dessert: Rasmalai')).toBeVisible();
    await cart.getByRole('button', { name: t('pos.cart.send') }).click();
    await expect(page.getByText(/^Order \d+ sent to the kitchen$/)).toBeVisible();
    await expect(cart.getByText(t('pos.cart.empty'))).toBeVisible();

    const sent = page.getByRole('region', { name: t('pos.sent.title') });
    await expect(sent.getByText(/Chicken Tikka \(Full\)/)).toBeVisible();
    await expect(sent.getByText(t('pos.itemState.SENT')).first()).toBeVisible();

    await page.getByRole('button', { name: t('pos.backToTables') }).click();
    await expect(
      page.getByRole('button', { name: /^7, Occupied, 2 guests, .*, ₹[\d,]+\.\d{2}/ }),
    ).toBeVisible();
  });

  test('[TBL-008] sends a takeaway order and shows its token', async () => {
    await page.getByRole('button', { name: t('pos.takeaway') }).click();
    await expect(page.getByRole('heading', { name: t('pos.takeaway') })).toBeVisible();
    await page.getByRole('button', { name: 'Breads', exact: true }).click();
    await page.getByRole('button', { name: /^Butter Naan, / }).click();
    await page.getByLabel(t('pos.cart.customer')).fill('Anil');
    await page
      .getByRole('complementary', { name: t('pos.cart.title') })
      .getByRole('button', { name: t('pos.cart.send') })
      .click();
    await expect(page.getByText(/^Token \d+: order \d+ sent to the kitchen$/)).toBeVisible();
    const open = page.getByRole('region', { name: t('pos.sent.openTakeaway') });
    await expect(open.getByText(/Token \d+ · Anil/)).toBeVisible();
    await expect(open.getByText('1 × Butter Naan')).toBeVisible();
  });

  test('[KDS-003] [KDS-005] [KDS-007] cooks, picks up, bumps and recalls a ticket on the kitchen display', async () => {
    await page.getByRole('button', { name: t('login.signOut') }).click();
    await page.getByRole('button', { name: /^Chef Imran/ }).click();
    await page.keyboard.type('6666');
    await expect(page).toHaveURL(/\/kds$/);
    const ticket = page.getByRole('article', { name: /^KOT \d+, Table 7$/ });
    await expect(ticket).toBeVisible();
    await expect(ticket.getByText('Veg Thali Combo')).toBeVisible();
    await expect(ticket.getByText(/Chicken Tikka \(Full\)/)).toBeVisible();
    await expect(page.getByRole('article', { name: /^KOT \d+, Token \d+$/ })).toBeVisible();

    await ticket.getByRole('button', { name: t('kds.allPreparing') }).click();
    await expect(ticket.getByRole('button', { name: t('kds.allReady') })).toBeVisible();
    await expect(ticket.getByRole('button', { name: /^Bump KOT/ })).toBeDisabled();
    await ticket.getByRole('button', { name: t('kds.allReady') }).click();
    await expect(ticket.getByRole('button', { name: /^Bump KOT/ })).toBeEnabled();
    const pickUp = ticket.getByRole('button', {
      name: t('kds.stepFor', { step: t('kds.step.PICK_UP'), item: 'Chicken Tikka' }),
    });
    await pickUp.click();
    await expect(pickUp).toHaveCount(0);

    await ticket.getByRole('button', { name: /^Bump KOT/ }).click();
    await expect(ticket).toHaveCount(0);
    await page.getByRole('button', { name: t('kds.recall'), exact: true }).click();
    const recall = page.getByRole('dialog', { name: t('kds.recallTitle') });
    await recall
      .getByRole('button', { name: /^Recall KOT/ })
      .first()
      .click();
    await recall.getByRole('button', { name: t('ui.dialog.close') }).click();
    await expect(page.getByRole('article', { name: /^KOT \d+, Table 7$/ })).toBeVisible();
  });

  test('[KDS-012] covers the board while disconnected and resyncs without duplicates', async () => {
    const tickets = page.getByRole('article');
    const before = await tickets.count();
    expect(before).toBeGreaterThan(0);
    await server.stop();
    await expect(page.getByText(t('kds.disconnectedTitle'))).toBeVisible();
    server = await startServer(server.port);
    await expect(page.getByText(t('kds.disconnectedTitle'))).toHaveCount(0, { timeout: 30_000 });
    await expect(tickets).toHaveCount(before);
  });

  test('[ORD-010] the POS sees the kitchen’s progress', async () => {
    await page.getByRole('button', { name: t('login.signOut') }).click();
    await page.getByRole('button', { name: /^Neha \(Cashier\)/ }).click();
    await page.keyboard.type('3333');
    await page.getByRole('button', { name: /^7, Occupied/ }).click();
    await page.getByRole('button', { name: t('pos.table.takeOrder') }).click();
    const sent = page.getByRole('region', { name: t('pos.sent.title') });
    await expect(sent.getByText(t('pos.itemState.PICKED_UP')).first()).toBeVisible();
    await expect(sent.getByText(t('pos.itemState.READY')).first()).toBeVisible();
  });

  test('[BILL-005] [BILL-008] [AUTH-011] bills a table with a manager-approved discount and a split payment in under a minute', async () => {
    const started = Date.now();
    await page.getByRole('button', { name: t('pos.backToTables') }).click();
    await page.getByRole('button', { name: t('pos.shift') }).click();
    await page.getByLabel(t('shift.openingFloat')).fill('1000');
    await page.getByRole('button', { name: t('shift.open') }).click();
    await expect(page.getByText(t('shift.expected'))).toBeVisible();
    await page.getByRole('button', { name: t('pos.backToTables') }).click();

    await page.getByRole('button', { name: /^7, Occupied/ }).click();
    await page.getByRole('button', { name: t('pos.billTable') }).click();
    await expect(
      page.getByRole('heading', {
        name: t('billing.billFor', { target: t('pos.table.title', { table: '7' }) }),
      }),
    ).toBeVisible();

    // 20 % is above the cashier's 10 % limit: a manager approves with their PIN.
    await page.getByRole('button', { name: t('billing.addDiscount') }).click();
    const discount = page.getByRole('dialog', { name: t('billing.discount.title') });
    await discount.getByLabel(t('billing.discount.percentValue')).fill('20');
    await discount.getByLabel(t('billing.discount.reason')).fill('Birthday');
    await discount.getByRole('button', { name: t('billing.discount.apply') }).click();
    const approval = page.getByRole('dialog', { name: t('override.title') });
    await approval.getByRole('button', { name: 'Vikram (Manager)' }).click();
    await page.keyboard.type('2222');
    await expect(page.getByText(/Birthday/)).toBeVisible();

    await page.getByRole('button', { name: t('billing.printBill') }).click();
    await page.getByRole('button', { name: t('billing.pay') }).click();
    await expect(page.getByRole('heading', { name: /^Payment for invoice / })).toBeVisible();

    await page.getByLabel(t('payment.mode')).selectOption({ label: t('payment.modes.UPI') });
    await page.getByLabel(t('payment.amount')).fill('100');
    await page.getByRole('button', { name: t('payment.add') }).click();
    await page.getByLabel(t('payment.mode')).selectOption({ label: t('payment.modes.CASH') });
    await page.getByLabel(t('payment.tendered')).fill('5000');
    await page.getByRole('button', { name: t('payment.record') }).click();
    await expect(page.getByText(/^Invoice .* is paid$/)).toBeVisible();
    await expect(page.getByText(t('billing.settled'))).toBeVisible();
    expect(Date.now() - started).toBeLessThan(60_000);

    // Paid in full: the table is free again.
    await page.getByRole('button', { name: t('pos.backToTables') }).click();
    await expect(page.getByRole('button', { name: '7, Free' })).toBeVisible();
  });
});
