import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { crc32, deflateSync } from 'node:zlib';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createTranslator } from '@rp/i18n';
import pg from 'pg';
import { type RunningServer, startServer } from './server.js';

/**
 * P0-14b acceptance: a real browser pairs with the real server, people sign in with their PIN and
 * land in their mode, and the offline banner shows while the server is down (NFR-P11). Later work
 * packages add their flows: the POS floor, orders, the kitchen display, the manager dashboard on a
 * desktop and a phone, billing, alerts, staff, devices, the menu editor and custom roles.
 */

const t = createTranslator();

/** The Owner's password, set up in the second-factor flow and confirmed again later. */
const OWNER_PASSWORD = 'rooftop tandoor since 1998';

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

/**
 * axe-core's browser build, to check pages against WCAG 2.2 AA (NFR-U05). It is evaluated through
 * the browser's debugging protocol: the server's Content Security Policy rightly refuses inline
 * scripts, so a script tag would not run.
 */
const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);

interface AxeViolation {
  readonly id: string;
  readonly help: string;
  readonly nodes: readonly { readonly target: readonly string[] }[];
}

/** No WCAG 2.2 A or AA violations on the page as it stands, colour contrast included. */
async function expectAccessible(page: Page): Promise<void> {
  // Let entrance animations (a dialog fading in) end, so colours are measured as people see them.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) =>
          animation.finished.then(
            () => undefined,
            () => undefined,
          ),
        ),
    ),
  );
  await page.evaluate(AXE_SOURCE);
  const violations = await page.evaluate(async () => {
    const { axe } = window as unknown as {
      axe: {
        run: (
          context: Document,
          options: { runOnly: { type: 'tag'; values: string[] } },
        ) => Promise<{ violations: AxeViolation[] }>;
      };
    };
    const results = await axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    });
    return results.violations.map(
      (violation) =>
        `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(' ')).join(', ')})`,
    );
  });
  expect(violations).toEqual([]);
}

/** How far the page is wider than the window: 0 when nothing scrolls sideways (MGR-011). */
function sidewaysOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/** Moves an item's "sent to the kitchen" time back, as if the kitchen had it that long. */
async function sentMinutesAgo(item: string, minutes: number): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.RP_E2E_DATABASE_URL });
  await client.connect();
  try {
    const { rowCount } = await client.query(
      `UPDATE order_items SET sent_at = now() - make_interval(mins => $2)
       WHERE name = $1 AND state = 'SENT'`,
      [item, minutes],
    );
    expect(rowCount).toBe(1);
  } finally {
    await client.end();
  }
}

/**
 * The code an authenticator app shows now for a base32 key (RFC 6238: HMAC-SHA1, 30 s steps,
 * 6 digits), as the Owner's phone would.
 */
function authenticatorCode(key: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of key.replace(/\s/g, '')) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/**
 * A 640 × 480 PNG in one colour, made here so the test needs no image file. The server re-encodes
 * it, so its 480 px rendition really is 480 px wide (MENU-008).
 */
function photoPng(): Buffer {
  const width = 640;
  const height = 480;
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const framed = Buffer.alloc(body.length + 8);
    framed.writeUInt32BE(data.length, 0);
    body.copy(framed, 4);
    framed.writeUInt32BE(crc32(body), body.length + 4);
    return framed;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // 8 bits per channel
  header.writeUInt8(2, 9); // RGB, no palette or alpha
  // Every row: filter type 0, then the pixels in saffron orange.
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(width * 3, Buffer.from([0xf0, 0x8c, 0x28])),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test.describe.serial('the web console', () => {
  let server: RunningServer;
  // One browser profile: the device key it keeps is shared by every tab, like a POS terminal's.
  let context: BrowserContext;
  let page: Page;
  // The Owner's one-time recovery codes, shown once when the authenticator is set up.
  let recoveryCodes: string[] = [];

  test.beforeAll(async ({ browser }) => {
    server = await startServer();
    context = await browser.newContext();
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context.close();
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

  test('[MGR-001] [MGR-002] [MGR-003] [MGR-011] [NFR-U05] the manager dashboard on a desktop and a phone', async () => {
    // The takeaway's naan has been in the kitchen for half an hour (kds.ageRedMinutes is 20).
    await sentMinutesAgo('Butter Naan', 30);
    await page.getByRole('button', { name: t('login.signOut') }).click();
    await page.getByRole('button', { name: /^Vikram \(Manager\)/ }).click();
    await page.keyboard.type('2222');
    await expect(page).toHaveURL(/\/manage$/);

    const nav = page.getByRole('navigation', { name: t('dashboard.navigation') });
    const link = (section: 'overview' | 'orders' | 'alerts') =>
      nav.getByRole('link', { name: t(`dashboard.section.${section}`) });
    await expect(link('overview')).toHaveAttribute('aria-current', 'page');
    const glance = page.getByRole('region', { name: t('dashboard.overview.glance') });
    await expect(
      glance.getByText(t('dashboard.overview.occupied', { occupied: 1, total: 10 })),
    ).toBeVisible();
    await expect(glance.getByText(t('dashboard.overview.guests', { count: 2 }))).toBeVisible();
    await expect(glance.getByText(t('dashboard.overview.orders', { count: 2 }))).toBeVisible();
    await expect(glance.getByText(t('dashboard.overview.delayed', { count: 1 }))).toBeVisible();
    const terrace = page
      .getByRole('region', { name: t('dashboard.overview.floor') })
      .getByRole('region', { name: 'Terrace' });
    await expect(terrace.getByRole('button', { name: /^8, Free/ })).toBeDisabled();
    await expectAccessible(page);

    // The occupied table opens its orders.
    await terrace.getByRole('button', { name: /^7, Occupied/ }).click();
    await expect(page).toHaveURL(/\/manage\/orders\?table=[^&]+&label=7$/);
    await expect(link('orders')).toHaveAttribute('aria-current', 'page');
    const feed = page.getByRole('region', { name: t('dashboard.orders.title') });
    await expect(page.getByText(t('dashboard.orders.table', { table: '7' }))).toBeVisible();
    const table7 = feed.getByRole('article', { name: /^Table 7 · Order \d+$/ });
    const token = feed.getByRole('article', { name: /^Token \d+ · Order \d+$/ });
    await expect(table7).toBeVisible();
    await expect(table7.getByText(t('pos.itemState.READY')).first()).toBeVisible();
    await expect(table7.getByText(/^1 × Chicken Tikka \(Full\)$/)).toBeVisible();
    await expect(token).toHaveCount(0);
    await page.getByRole('button', { name: t('dashboard.orders.allTables') }).click();
    await expect(token).toBeVisible();

    // Filters: a station with nothing cooking, then late dishes only. The browser runs 30 times
    // slower here, so a filter picked straight after another comes before the first has shown: it
    // must still add to it, and the checkbox must stay ticked.
    const cpu = await page.context().newCDPSession(page);
    await cpu.send('Emulation.setCPUThrottlingRate', { rate: 30 });
    const filters = page.getByRole('group', { name: t('dashboard.orders.filters') });
    await filters.getByLabel(t('dashboard.orders.station')).selectOption({ label: 'Bar' });
    await expect(page.getByText(t('dashboard.orders.noneMatch'))).toBeVisible();
    await filters.getByLabel(t('dashboard.orders.station')).selectOption({ label: 'Kitchen' });
    await filters.getByLabel(t('dashboard.orders.source')).selectOption({ label: 'POS' });
    await expect(table7).toBeVisible();
    await filters.getByRole('checkbox', { name: t('dashboard.orders.delayedOnly') }).check();
    await expect(table7).toHaveCount(0);
    await expect(token.getByText(t('dashboard.orders.delayed'))).toBeVisible();
    await expect(token.getByText(/^Late: 3\d min in the kitchen, expected 20$/)).toBeVisible();
    await expect(page).toHaveURL(/delayed=1/);
    await cpu.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await cpu.detach();
    await expectAccessible(page);

    // A 360 px phone: the same pages, nothing wider than the screen.
    await page.setViewportSize({ width: 360, height: 780 });
    await expect(token).toBeVisible();
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
    await expectAccessible(page);
    await link('overview').click();
    await expect(glance.getByText(t('dashboard.overview.orders', { count: 2 }))).toBeVisible();
    await expect(terrace.getByRole('button', { name: /^7, Occupied/ })).toBeVisible();
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
    await expectAccessible(page);
    await link('alerts').click();
    await expect(page.getByRole('heading', { level: 2, name: t('alerts.title') })).toBeVisible();
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1280, height: 720 });
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
    await expect(page.getByText(t('billing.settled'), { exact: true })).toBeVisible();
    expect(Date.now() - started).toBeLessThan(60_000);

    // Paid in full: the table is free again.
    await page.getByRole('button', { name: t('pos.backToTables') }).click();
    await expect(page.getByRole('button', { name: '7, Free' })).toBeVisible();
  });

  test('[BILL-007] splits a table’s bill in two and settles each part within a minute', async () => {
    const hall = page.getByRole('region', { name: 'Main Hall' });
    await hall.getByRole('button', { name: '2, Free' }).click();
    const open = page.getByRole('dialog', { name: t('pos.open.title', { table: '2' }) });
    await open.getByLabel(t('pos.open.guests'), { exact: true }).fill('2');
    await open.getByRole('button', { name: t('pos.open.submit') }).click();
    await hall.getByRole('button', { name: /^2, Occupied/ }).click();
    await page.getByRole('button', { name: t('pos.table.takeOrder') }).click();
    await page.getByRole('button', { name: 'Breads', exact: true }).click();
    await page.getByRole('button', { name: /^Butter Naan, / }).click();
    await page.getByRole('button', { name: /^Butter Naan, / }).click();
    const cart = page.getByRole('complementary', { name: t('pos.cart.title') });
    await cart.getByRole('button', { name: t('pos.cart.send') }).click();
    await expect(page.getByText(/^Order \d+ sent to the kitchen$/)).toBeVisible();
    await page.getByRole('button', { name: t('pos.backToTables') }).click();

    const started = Date.now();
    await hall.getByRole('button', { name: /^2, Occupied/ }).click();
    await page.getByRole('button', { name: t('pos.billTable') }).click();
    await page.getByRole('button', { name: t('billing.split.open') }).click();
    const split = page.getByRole('dialog', { name: t('billing.split.title') });
    await split.getByRole('button', { name: t('billing.split.submit') }).click();
    await expect(page.getByText(t('billing.split.done', { count: 2 }))).toBeVisible();

    for (let part = 0; part < 2; part += 1) {
      await page
        .getByRole('button', { name: t('billing.pay') })
        .first()
        .click();
      await expect(page.getByRole('heading', { name: /^Payment for invoice / })).toBeVisible();
      await page.getByLabel(t('payment.mode')).selectOption({ label: t('payment.modes.CASH') });
      await page.getByLabel(t('payment.tendered')).fill('500');
      await page.getByRole('button', { name: t('payment.record') }).click();
      await expect(page.getByText(/^Invoice .* is paid$/).first()).toBeVisible();
    }
    await expect(page.getByText(t('billing.settled'), { exact: true })).toHaveCount(2);
    expect(Date.now() - started).toBeLessThan(60_000);

    await page.getByRole('button', { name: t('pos.backToTables') }).click();
    await expect(hall.getByRole('button', { name: '2, Free' })).toBeVisible();
  });

  test('[NTF-008] [NTF-004] [MGR-008] a manager nudges a waiter and acknowledges the alert', async () => {
    await page.getByRole('button', { name: t('login.signOut') }).click();
    await page.getByRole('button', { name: /^Vikram \(Manager\)/ }).click();
    await page.keyboard.type('2222');
    await expect(page).toHaveURL(/\/manage$/);
    await page
      .getByRole('navigation', { name: t('dashboard.navigation') })
      .getByRole('link', { name: t('dashboard.section.alerts') })
      .click();
    await expect(page.getByRole('heading', { level: 2, name: t('alerts.title') })).toBeVisible();

    await page.getByRole('button', { name: t('alerts.nudge.open') }).click();
    const nudge = page.getByRole('dialog', { name: t('alerts.nudge.title') });
    await nudge.getByRole('checkbox', { name: 'Ravi' }).check();
    await nudge.getByRole('button', { name: 'Come to counter' }).click();
    await nudge.getByRole('button', { name: t('alerts.nudge.send') }).click();
    await expect(page.getByText(t('alerts.nudge.sent', { count: 1, name: 'Ravi' }))).toBeVisible();

    // Managers see every open alert: Ravi's nudge shows, live, until someone acknowledges it.
    const acknowledge = page.getByRole('button', {
      name: t('alerts.acknowledgeOf', { title: 'Come to counter' }),
    });
    await expect(acknowledge).toBeVisible();
    await acknowledge.click();
    await expect(acknowledge).toHaveCount(0);
  });
  test('[MGR-004] [AUTH-001] [AUTH-008] a manager adds a waiter who signs in, then deactivates them and they are signed out', async () => {
    // A second screen on this device, waiting on the sign-in screen.
    const other = await context.newPage();
    await other.goto(server.url);
    await expect(other.getByRole('heading', { name: t('login.title') })).toBeVisible();
    const sunilTile = other.getByRole('button', { name: /^Sunil/ });
    await expect(sunilTile).toHaveCount(0);

    await page.getByRole('button', { name: t('login.signOut') }).click();
    await page.getByRole('button', { name: /^Vikram \(Manager\)/ }).click();
    await page.keyboard.type('2222');
    await expect(page).toHaveURL(/\/manage$/);
    await page
      .getByRole('navigation', { name: t('dashboard.navigation') })
      .getByRole('link', { name: t('dashboard.section.staff') })
      .click();
    await expect(page.getByRole('heading', { level: 2, name: t('staff.title') })).toBeVisible();

    await page.getByRole('button', { name: t('staff.add') }).click();
    const add = page.getByRole('dialog', { name: t('staff.form.addTitle') });
    await add.getByLabel(t('staff.form.name'), { exact: false }).first().fill('Sunil');
    await expect(add.getByLabel(t('staff.form.role'))).toHaveValue('WAITER');
    await add.getByLabel(/^PIN( \*)?$/).fill('7777');
    await add.getByLabel(/^PIN again( \*)?$/).fill('7777');
    await expectAccessible(page);
    await add.getByRole('button', { name: t('staff.form.add') }).click();
    await expect(page.getByText(t('staff.added', { name: 'Sunil' }))).toBeVisible();
    const sunil = page.getByRole('group', { name: t('staff.actionsFor', { name: 'Sunil' }) });
    await expect(sunil).toBeVisible();
    await expectAccessible(page);

    // The new waiter shows on the other screen without a reload, and signs in with the new PIN.
    await sunilTile.click();
    await other.keyboard.type('7777');
    await expect(other).toHaveURL(/\/pos$/);

    // A 360 px phone: the Staff page fits (MGR-011).
    await page.setViewportSize({ width: 360, height: 780 });
    await expect(sunil).toBeVisible();
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1280, height: 720 });

    await sunil.getByRole('button', { name: t('staff.deactivate') }).click();
    const deactivate = page.getByRole('dialog', {
      name: t('staff.deactivateDialog.title', { name: 'Sunil' }),
    });
    await deactivate.getByLabel(t('staff.deactivateDialog.reason')).fill('Trial shift over');
    await deactivate.getByRole('button', { name: t('staff.deactivateDialog.confirm') }).click();
    await expect(page.getByText(t('staff.deactivated', { name: 'Sunil' }))).toBeVisible();
    const deactivated = Date.now();

    // Signed out on the other screen within seconds (AUTH-008), and off its sign-in tiles.
    await expect(other.getByRole('heading', { name: t('login.title') })).toBeVisible({
      timeout: 5_000,
    });
    expect(Date.now() - deactivated).toBeLessThan(5_000);
    await expect(other.getByText(t('login.signedOut'))).toBeVisible();
    await expect(sunilTile).toHaveCount(0);
    await expect(sunil.getByRole('button', { name: t('staff.reactivate') })).toBeVisible();
    await other.close();
  });

  test('[AUTH-006] the Owner sets up password and authenticator, then adds a manager with the second factor', async () => {
    await page.getByRole('button', { name: t('login.signOut') }).click();
    await page.getByRole('button', { name: /^Asha \(Owner\)/ }).click();
    await page.keyboard.type('1111');
    await expect(page).toHaveURL(/\/manage$/);
    const nav = page.getByRole('navigation', { name: t('dashboard.navigation') });
    await nav.getByRole('link', { name: t('dashboard.section.security') }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: t('ownerSecurity.title') }),
    ).toBeVisible();
    await expectAccessible(page);

    const password = OWNER_PASSWORD;
    await page.getByRole('button', { name: t('ownerSecurity.password.setAction') }).click();
    const setPassword = page.getByRole('dialog', { name: t('ownerSecurity.password.setAction') });
    await setPassword.getByLabel(/^New password( \*)?$/).fill(password);
    await setPassword.getByLabel(/^New password again( \*)?$/).fill(password);
    await setPassword.getByRole('button', { name: t('ownerSecurity.password.save') }).click();
    await expect(page.getByText(t('ownerSecurity.password.saved'))).toBeVisible();

    await page.getByRole('button', { name: t('ownerSecurity.authenticator.add') }).click();
    const enrol = page.getByRole('dialog', { name: t('ownerSecurity.authenticator.add') });
    await expect(
      enrol.getByRole('img', { name: t('ownerSecurity.authenticator.qrLabel') }),
    ).toBeVisible();
    await expectAccessible(page);
    // The phone reads the key (typed here, as "Can't scan it?" offers) and shows the code.
    const key = await enrol.locator('code').innerText();
    await enrol
      .getByLabel(t('ownerSecurity.authenticator.code'), { exact: false })
      .fill(authenticatorCode(key));
    await enrol.getByRole('button', { name: t('ownerSecurity.authenticator.confirm') }).click();
    const codes = page.getByRole('dialog', { name: t('ownerSecurity.recovery.saveTitle') });
    const recovery = codes
      .getByRole('list', { name: t('ownerSecurity.recovery.codes') })
      .getByRole('listitem');
    await expect(recovery).toHaveCount(10);
    recoveryCodes = await recovery.allInnerTexts();
    const firstCode = recoveryCodes[0] ?? '';
    await codes.getByRole('button', { name: t('ownerSecurity.recovery.saved') }).click();
    await expect(page.getByText(t('ownerSecurity.recovery.left', { count: 10 }))).toBeVisible();

    // Adding a manager asks for the password and a second factor: this time a recovery code.
    await nav.getByRole('link', { name: t('dashboard.section.staff') }).click();
    await page.getByRole('button', { name: t('staff.add') }).click();
    const add = page.getByRole('dialog', { name: t('staff.form.addTitle') });
    await add.getByLabel(t('staff.form.name'), { exact: false }).first().fill('Farah');
    await add.getByLabel(t('staff.form.role')).selectOption({ label: t('roles.MANAGER') });
    await add.getByLabel(/^PIN( \*)?$/).fill('8888');
    await add.getByLabel(/^PIN again( \*)?$/).fill('8888');
    await add.getByRole('button', { name: t('staff.form.add') }).click();
    const confirm = page.getByRole('dialog', { name: t('secondFactor.title') });
    await confirm.getByLabel(t('secondFactor.password'), { exact: false }).fill(password);
    await confirm.getByRole('button', { name: t('secondFactor.useRecovery') }).click();
    await confirm.getByLabel(t('secondFactor.recoveryCode'), { exact: false }).fill(firstCode);
    await expectAccessible(page);
    await confirm.getByRole('button', { name: t('secondFactor.confirm') }).click();
    await expect(page.getByText(t('staff.added', { name: 'Farah' }))).toBeVisible();
    await expect(
      page.getByRole('group', { name: t('staff.actionsFor', { name: 'Farah' }) }),
    ).toBeVisible();

    await nav.getByRole('link', { name: t('dashboard.section.security') }).click();
    await expect(page.getByText(t('ownerSecurity.recovery.left', { count: 9 }))).toBeVisible();
  });

  test('[TBL-002] [PGR-012] [MGR-004] a manager gives waiters their sections and a pager at shift start', async () => {
    await page.getByRole('button', { name: t('login.signOut') }).click();
    await page.getByRole('button', { name: /^Vikram \(Manager\)/ }).click();
    await page.keyboard.type('2222');
    await expect(page).toHaveURL(/\/manage$/);
    await page
      .getByRole('navigation', { name: t('dashboard.navigation') })
      .getByRole('link', { name: t('dashboard.section.staff') })
      .click();
    const pages = page.getByRole('navigation', { name: t('staff.pages.label') });
    await pages.getByRole('link', { name: t('staff.pages.sections') }).click();
    await expect(page.getByRole('heading', { level: 2, name: t('sections.title') })).toBeVisible();
    await expect(
      page.getByText(t('sections.uncoveredSection', { section: 'Main Hall' })),
    ).toBeVisible();

    // Ravi takes the hall; Sunita the terrace and table 1, which leaves Ravi's hall for her.
    const change = (name: string) =>
      page.getByRole('button', { name: t('sections.changeFor', { name }) });
    const tablesOf = (name: string) =>
      page.getByRole('dialog', { name: t('sections.dialog.title', { name }) });
    await change('Ravi').click();
    await tablesOf('Ravi')
      .getByRole('checkbox', { name: /^Main Hall/ })
      .check();
    await tablesOf('Ravi')
      .getByRole('button', { name: t('sections.dialog.save') })
      .click();
    await expect(page.getByText(t('sections.saved', { name: 'Ravi' }))).toBeVisible();

    await change('Sunita').click();
    await tablesOf('Sunita')
      .getByRole('checkbox', { name: /^Terrace/ })
      .check();
    await tablesOf('Sunita')
      .getByRole('group', { name: t('sections.dialog.tables', { section: 'Main Hall' }) })
      .getByRole('checkbox', { name: '1', exact: true })
      .check();
    await expectAccessible(page);
    await tablesOf('Sunita')
      .getByRole('button', { name: t('sections.dialog.save') })
      .click();
    await expect(page.getByText(t('sections.saved', { name: 'Sunita' }))).toBeVisible();
    await expect(page.getByText(t('sections.allCovered'))).toBeVisible();
    const row = (name: string) =>
      page.getByRole('listitem').filter({ has: page.getByRole('heading', { level: 3, name }) });
    await expect(row('Ravi').getByText(t('sections.tableCount', { count: 5 }))).toBeVisible();
    await expect(row('Sunita').getByText(t('sections.tablesLine', { tables: '1' }))).toBeVisible();
    await expect(row('Sunita').getByText(t('sections.tableCount', { count: 5 }))).toBeVisible();
    await expectAccessible(page);

    // The pagers: register one for Ravi, then hand it to Sunita at shift start.
    await pages.getByRole('link', { name: t('staff.pages.pagers') }).click();
    await expect(page.getByRole('heading', { level: 2, name: t('pagers.title') })).toBeVisible();
    await expect(page.getByText(t('pagers.none'))).toBeVisible();
    await page.getByRole('button', { name: t('pagers.register') }).click();
    const register = page.getByRole('dialog', { name: t('pagers.form.title') });
    await expect(register.getByLabel(/^Name( \*)?$/)).toHaveValue('Pager 1');
    await register.getByLabel(/^Serial( \*)?$/).fill('WP-0101');
    await register.getByLabel(t('pagers.form.wearer')).selectOption({ label: 'Ravi' });
    await expectAccessible(page);
    await register.getByRole('button', { name: t('pagers.form.register') }).click();
    const shown = page.getByRole('dialog', {
      name: t('pagers.credentialDialog.title', { pager: 'Pager 1' }),
    });
    await expect(shown.locator('code')).toHaveCount(3);
    expect((await shown.locator('code').nth(1).innerText()).length).toBeGreaterThanOrEqual(24);
    await expectAccessible(page);
    await shown.getByRole('button', { name: t('pagers.credentialDialog.done') }).click();
    const pager = row('Pager 1');
    await expect(pager.getByText(t('pagers.wornBy', { name: 'Ravi' }))).toBeVisible();
    await expect(pager.getByText(t('pagers.notConnected'))).toBeVisible();

    // Re-assignment at shift start takes seconds, not the 30 s allowed (PGR-012).
    const started = Date.now();
    await pager.getByRole('button', { name: t('pagers.giveOther') }).click();
    const give = page.getByRole('dialog', {
      name: t('pagers.giveDialog.title', { pager: 'Pager 1' }),
    });
    await give.getByLabel(t('pagers.giveDialog.person'), { exact: false }).selectOption({
      label: 'Sunita',
    });
    await give.getByRole('button', { name: t('pagers.giveDialog.confirm') }).click();
    await expect(
      page.getByText(t('pagers.given', { pager: 'Pager 1', name: 'Sunita' })),
    ).toBeVisible();
    await expect(pager.getByText(t('pagers.wornBy', { name: 'Sunita' }))).toBeVisible();
    expect(Date.now() - started).toBeLessThan(30_000);

    // A 360 px phone: the Pagers page fits (MGR-011).
    await page.setViewportSize({ width: 360, height: 780 });
    await expect(pager).toBeVisible();
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expectAccessible(page);
  });

  test('[MGR-006] [AUTH-007] [AUTH-008] a manager pairs a kitchen screen, locates and renames it, then unpairs it', async ({
    browser,
  }) => {
    // Vikram is still signed in from the previous test.
    await expect(page).toHaveURL(/\/manage/);
    const nav = page.getByRole('navigation', { name: t('dashboard.navigation') });
    await nav.getByRole('link', { name: t('dashboard.section.devices') }).click();
    await expect(page.getByRole('heading', { level: 2, name: t('devices.title') })).toBeVisible();
    const row = (name: string) =>
      page.getByRole('listitem').filter({
        has: page.getByRole('heading', { level: 4, name: new RegExp(`^${escape(name)}`) }),
      });
    await expect(
      row('Server POS').getByText(t('devices.thisDevice'), { exact: true }),
    ).toBeVisible();
    await expect(row('Pager 1').getByText(t('devices.wornBy', { name: 'Sunita' }))).toBeVisible();
    await expectAccessible(page);

    // Pair a kitchen screen for the whole kitchen.
    await page.getByRole('button', { name: t('devices.pair') }).click();
    const pair = page.getByRole('dialog', { name: t('devices.pairDialog.title') });
    await pair
      .getByLabel(t('devices.pairDialog.type'))
      .selectOption({ label: t('devices.type.KDS') });
    await expect(pair.getByLabel(/^Name( \*)?$/)).toHaveValue('Kitchen screen 1');
    await pair
      .getByLabel(t('devices.pairDialog.station'), { exact: false })
      .selectOption({ label: 'Kitchen' });
    await expectAccessible(page);
    await pair.getByRole('button', { name: t('devices.pairDialog.create') }).click();
    const issued = page.getByRole('dialog', {
      name: t('devices.pairDialog.codeTitle', { name: 'Kitchen screen 1' }),
    });
    await expect(issued.getByRole('status')).toHaveText(t('devices.pairDialog.waiting'));
    const code = await issued.locator('code').first().innerText();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    await expectAccessible(page);

    // Another browser is the kitchen screen: it pairs with the code and shows the kitchen.
    const kitchen = await browser.newContext();
    const screen = await kitchen.newPage();
    await screen.goto(server.url);
    await screen.getByLabel(t('pairing.codeLabel')).fill(code);
    await screen.getByRole('button', { name: t('pairing.submit') }).click();
    await expect(screen).toHaveURL(/\/kds$/);
    await expect(screen.getByText('Kitchen screen 1')).toBeVisible();
    await expect(issued.getByRole('status')).toHaveText(
      t('devices.pairDialog.paired', { name: 'Kitchen screen 1' }),
    );
    await issued.getByRole('button', { name: t('devices.pairDialog.done') }).click();
    const kds = row('Kitchen screen 1');
    await expect(kds.getByText(t('devices.station', { station: 'Kitchen' }))).toBeVisible();
    // Connection states are read again every minute; reading the page again shows it now.
    await page.reload();
    await expect(kds.getByText(t('devices.connected'))).toBeVisible();

    // Locate: the screen shows its name.
    await kds.getByRole('button', { name: t('devices.locate') }).click();
    await expect(page.getByText(t('devices.located', { name: 'Kitchen screen 1' }))).toBeVisible();
    const located = screen.getByRole('dialog', {
      name: t('locate.title', { name: 'Kitchen screen 1' }),
    });
    await expect(located).toBeVisible();
    await located.getByRole('button', { name: t('locate.dismiss') }).click();
    await expect(located).toHaveCount(0);

    // Rename: the screen's header follows at once.
    await kds.getByRole('button', { name: t('devices.rename') }).click();
    const rename = page.getByRole('dialog', {
      name: t('devices.renameDialog.title', { name: 'Kitchen screen 1' }),
    });
    await rename.getByLabel(/^New name( \*)?$/).fill('Tandoor screen');
    await rename.getByRole('button', { name: t('devices.renameDialog.confirm') }).click();
    await expect(page.getByText(t('devices.renamed', { name: 'Tandoor screen' }))).toBeVisible();
    await expect(screen.getByText('Tandoor screen')).toBeVisible();

    // A 360 px phone: the Devices page fits (MGR-011).
    await page.setViewportSize({ width: 360, height: 780 });
    await expect(row('Tandoor screen')).toBeVisible();
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1280, height: 720 });

    // Unpair: the screen is back on the pairing screen within seconds (AUTH-008).
    await row('Tandoor screen')
      .getByRole('button', { name: t('devices.unpair') })
      .click();
    const unpair = page.getByRole('dialog', {
      name: t('devices.unpairDialog.title', { name: 'Tandoor screen' }),
    });
    await unpair.getByLabel(t('devices.unpairDialog.reason')).fill('Moved to the other branch');
    await expectAccessible(page);
    await unpair.getByRole('button', { name: t('devices.unpairDialog.confirm') }).click();
    const unpaired = Date.now();
    await expect(page.getByText(t('devices.unpaired', { name: 'Tandoor screen' }))).toBeVisible();
    await expect(screen).toHaveURL(/\/pair$/, { timeout: 5_000 });
    expect(Date.now() - unpaired).toBeLessThan(5_000);
    await expect(screen.getByText(t('pairing.revoked'))).toBeVisible();
    await expect(row('Tandoor screen')).toHaveCount(0);
    await kitchen.close();
  });

  test('[MGR-005] [MENU-003] [MENU-004] [MENU-008] [MENU-013] a manager adds a dish with sizes, a new modifier group and a photo, publishes it and the POS sells it', async () => {
    // Vikram is still signed in from the previous test.
    await expect(page).toHaveURL(/\/manage/);
    const nav = page.getByRole('navigation', { name: t('dashboard.navigation') });
    await nav.getByRole('link', { name: t('dashboard.section.menu') }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: t('menuEditor.items.title') }),
    ).toBeVisible();
    // The demo menu was published as version 1 and nothing has changed since.
    const publishing = page.getByRole('region', { name: t('menuEditor.publish.label') });
    await expect(publishing.getByText(/^Version 1 is on every screen/)).toBeVisible();
    await expect(publishing.getByText(t('menuEditor.publish.upToDate'))).toBeVisible();
    await expectAccessible(page);

    // A new modifier group: an optional dip, one of two, one of them extra.
    const pages = page.getByRole('navigation', { name: t('menuEditor.pages.label') });
    await pages.getByRole('link', { name: t('menuEditor.pages.modifiers') }).click();
    await page.getByRole('button', { name: t('menuEditor.modifiers.add') }).click();
    const group = page.getByRole('dialog', { name: t('menuEditor.modifiers.dialog.addTitle') });
    await group.getByLabel(/^Name( \*)?$/).fill('Dip');
    const option = (key: 'optionName' | 'optionPrice', number: number) =>
      group.getByLabel(t(`menuEditor.modifiers.dialog.${key}`, { number }), { exact: true });
    await option('optionName', 1).fill('Mint chutney');
    await group.getByRole('button', { name: t('menuEditor.modifiers.dialog.addOption') }).click();
    await option('optionName', 2).fill('Cheese dip');
    await option('optionPrice', 2).fill('30');
    await expectAccessible(page);
    await group.getByRole('button', { name: t('menuEditor.modifiers.dialog.save') }).click();
    await expect(page.getByText(t('menuEditor.modifiers.saved', { name: 'Dip' }))).toBeVisible();

    // The dish: two sizes, the dip and a photo.
    await pages.getByRole('link', { name: t('menuEditor.pages.items') }).click();
    await page.getByRole('button', { name: t('menuEditor.items.add') }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: t('menuEditor.editor.newTitle') }),
    ).toBeVisible();
    await page.getByLabel(/^Name( \*)?$/).fill('Paneer Kathi Roll');
    await page.getByLabel(/^Category( \*)?$/).selectOption({ label: 'Starters' });
    await page.getByRole('radio', { name: t('pos.menu.foodType.VEG'), exact: true }).check();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: t('menuEditor.editor.choosePhoto') }).click();
    await (
      await chooser
    ).setFiles({ name: 'kathi-roll.png', mimeType: 'image/png', buffer: photoPng() });
    const photo = page.getByRole('img', {
      name: t('menuEditor.editor.photoAlt', { name: 'Paneer Kathi Roll' }),
    });
    await expect(photo).toBeVisible();
    // Stored, resized and served back to the browser.
    await expect
      .poll(() => photo.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(480);
    await page.getByLabel(/^Price \(₹\)( \*)?$/).fill('160');
    await page.getByLabel(/^Tax group( \*)?$/).selectOption({ label: 'GST 5 %' });
    const size = (key: 'sizeName' | 'sizePrice', number: number) =>
      page.getByLabel(t(`menuEditor.editor.${key}`, { number }), { exact: true });
    await page.getByRole('button', { name: t('menuEditor.editor.addSize') }).click();
    await size('sizeName', 1).fill('Regular');
    await size('sizePrice', 1).fill('160');
    await page.getByRole('button', { name: t('menuEditor.editor.addSize') }).click();
    await size('sizeName', 2).fill('Jumbo');
    await size('sizePrice', 2).fill('220');
    await page.getByRole('checkbox', { name: /^Dip/ }).check();
    await page.getByLabel(/^Kitchen station( \*)?$/).selectOption({ label: 'Kitchen' });
    await expectAccessible(page);
    // A 360 px phone: the editor fits (MGR-011).
    await page.setViewportSize({ width: 360, height: 780 });
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('button', { name: t('menuEditor.editor.save') }).click();
    await expect(
      page.getByText(t('menuEditor.editor.saved', { name: 'Paneer Kathi Roll' })),
    ).toBeVisible();

    // Back on the list: saved as a draft, not yet on any screen.
    const row = page
      .getByRole('listitem')
      .filter({ has: page.getByText('Paneer Kathi Roll', { exact: true }) });
    await expect(
      row.getByText(t('menuEditor.items.priceRange', { low: '₹160.00', high: '₹220.00' })),
    ).toBeVisible();
    await expect(row.getByText(t('menuEditor.items.sizes', { count: 2 }))).toBeVisible();
    await expect(publishing.getByText(t('menuEditor.publish.changes'))).toBeVisible();
    await page.setViewportSize({ width: 360, height: 780 });
    await expect(row).toBeVisible();
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1280, height: 720 });

    // Publish: every screen gets version 2.
    await publishing.getByRole('button', { name: t('menuEditor.publish.button') }).click();
    const confirm = page.getByRole('dialog', { name: t('menuEditor.publish.confirmTitle') });
    await expectAccessible(page);
    await confirm
      .getByRole('button', { name: t('menuEditor.publish.confirm'), exact: true })
      .click();
    await expect(page.getByText(t('menuEditor.publish.done', { version: 2 }))).toBeVisible();
    await expect(publishing.getByText(/^Version 2 is on every screen/)).toBeVisible();
    await expect(publishing.getByText(t('menuEditor.publish.upToDate'))).toBeVisible();

    // The cashier's POS offers it with its sizes and the dip, and takes the order.
    await page.getByRole('button', { name: t('login.signOut') }).click();
    await page.getByRole('button', { name: /^Neha \(Cashier\)/ }).click();
    await page.keyboard.type('3333');
    await expect(page).toHaveURL(/\/pos$/);
    await page.getByRole('button', { name: t('pos.takeaway') }).click();
    await page.getByRole('button', { name: 'Starters', exact: true }).click();
    await page.getByRole('button', { name: /^Paneer Kathi Roll, / }).click();
    const roll = page.getByRole('dialog', { name: 'Paneer Kathi Roll' });
    await roll.getByRole('radio', { name: /Jumbo/ }).check();
    await roll.getByRole('radio', { name: /^Cheese dip/ }).check();
    await roll.getByRole('button', { name: t('pos.item.add') }).click();
    const cart = page.getByRole('complementary', { name: t('pos.cart.title') });
    await expect(cart.getByText('Jumbo · Cheese dip')).toBeVisible();
    await page.getByLabel(t('pos.cart.customer')).fill('Meera');
    await cart.getByRole('button', { name: t('pos.cart.send') }).click();
    await expect(page.getByText(/^Token \d+: order \d+ sent to the kitchen$/)).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: t('pos.sent.openTakeaway') })
        .getByText('1 × Paneer Kathi Roll (Jumbo)'),
    ).toBeVisible();
  });

  test('[SEC-003] a cashier cannot open the Staff or Devices pages', async () => {
    await page.getByRole('button', { name: t('login.signOut') }).click();
    await page.getByRole('button', { name: /^Neha \(Cashier\)/ }).click();
    await page.keyboard.type('3333');
    await expect(page).toHaveURL(/\/pos$/);
    await page.goto(`${server.url}/manage/staff`);
    await expect(page.getByText(t('modes.notAllowed', { mode: t('modes.manage') }))).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: t('staff.title') })).toHaveCount(0);
    await page.goto(`${server.url}/manage/devices`);
    await expect(page.getByText(t('modes.notAllowed', { mode: t('modes.manage') }))).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: t('devices.title') })).toHaveCount(0);
  });

  test('[AUTH-012] [AUTH-006] the Owner creates a Captain role, gives it to Ravi, and Ravi settles a bill', async () => {
    await page.goto(server.url);
    await page.getByRole('button', { name: t('login.signOut') }).click();
    await page.getByRole('button', { name: /^Asha \(Owner\)/ }).click();
    await page.keyboard.type('1111');
    await expect(page).toHaveURL(/\/manage$/);
    await page
      .getByRole('navigation', { name: t('dashboard.navigation') })
      .getByRole('link', { name: t('dashboard.section.staff') })
      .click();
    const staffPages = page.getByRole('navigation', { name: t('staff.pages.label') });
    await staffPages.getByRole('link', { name: t('staff.pages.roles') }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: t('customRoles.title') }),
    ).toBeVisible();
    await expect(page.getByText(t('customRoles.none'))).toBeVisible();

    // A captain: a waiter who also prints bills and takes payments.
    await page.getByRole('button', { name: t('customRoles.add') }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: t('customRoles.editor.newTitle') }),
    ).toBeVisible();
    await page.getByLabel(/^Name( \*)?$/).fill('Captain');
    await expect(page.getByLabel(/^Built on/)).toHaveValue('WAITER');
    await page
      .getByLabel(new RegExp(`^${escape(t('capabilities.BILL_PRINT_AND_PAYMENT'))}`))
      .selectOption({ label: t('customRoles.editor.grants.ALLOW') });
    await expectAccessible(page);
    // A 360 px phone: the editor fits (MGR-011).
    await page.setViewportSize({ width: 360, height: 780 });
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('button', { name: t('customRoles.editor.create') }).click();
    // A new sign-in: the Owner confirms password and a second factor again.
    const confirm = page.getByRole('dialog', { name: t('secondFactor.title') });
    await confirm.getByLabel(t('secondFactor.password'), { exact: false }).fill(OWNER_PASSWORD);
    await confirm.getByRole('button', { name: t('secondFactor.useRecovery') }).click();
    await confirm
      .getByLabel(t('secondFactor.recoveryCode'), { exact: false })
      .fill(recoveryCodes[1] ?? '');
    await confirm.getByRole('button', { name: t('secondFactor.confirm') }).click();
    await expect(page.getByText(t('customRoles.created', { name: 'Captain' }))).toBeVisible();
    const captain = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: 'Captain', exact: true }) });
    await expect(
      captain.getByText(t('customRoles.adds', { list: t('capabilities.BILL_PRINT_AND_PAYMENT') })),
    ).toBeVisible();
    await expectAccessible(page);

    // Ravi becomes a captain.
    await staffPages.getByRole('link', { name: t('staff.pages.people') }).click();
    await page
      .getByRole('group', { name: t('staff.actionsFor', { name: 'Ravi' }) })
      .getByRole('button', { name: t('staff.edit') })
      .click();
    const edit = page.getByRole('dialog', { name: t('staff.form.editTitle', { name: 'Ravi' }) });
    await edit.getByLabel(t('staff.form.role')).selectOption({ label: 'Captain (Waiter)' });
    await edit.getByRole('button', { name: t('staff.form.save') }).click();
    await expect(page.getByText(t('staff.saved', { name: 'Ravi' }))).toBeVisible();
    await expect(
      page
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { name: /^Ravi/ }) })
        .getByText('Captain (Waiter)'),
    ).toBeVisible();

    // He signs in as a captain, seats guests, and settles their bill himself.
    await page.getByRole('button', { name: t('login.signOut') }).click();
    const ravi = page.getByRole('button', { name: /^Ravi/ });
    await expect(ravi).toContainText('Captain');
    await ravi.click();
    await page.keyboard.type('4444');
    await expect(page).toHaveURL(/\/pos$/);
    await expect(
      page.getByText(t('modes.signedInAs', { name: 'Ravi', role: 'Captain' })),
    ).toBeVisible();
    const hall = page.getByRole('region', { name: 'Main Hall' });
    await hall.getByRole('button', { name: '3, Free' }).click();
    const open = page.getByRole('dialog', { name: t('pos.open.title', { table: '3' }) });
    await open.getByLabel(t('pos.open.guests'), { exact: true }).fill('2');
    await open.getByRole('button', { name: t('pos.open.submit') }).click();
    await hall.getByRole('button', { name: /^3, Occupied/ }).click();
    await page.getByRole('button', { name: t('pos.table.takeOrder') }).click();
    await page.getByRole('button', { name: 'Breads', exact: true }).click();
    await page.getByRole('button', { name: /^Butter Naan, / }).click();
    await page
      .getByRole('complementary', { name: t('pos.cart.title') })
      .getByRole('button', { name: t('pos.cart.send') })
      .click();
    await expect(page.getByText(/^Order \d+ sent to the kitchen$/)).toBeVisible();
    await page.getByRole('button', { name: t('pos.backToTables') }).click();

    await hall.getByRole('button', { name: /^3, Occupied/ }).click();
    await page.getByRole('button', { name: t('pos.billTable') }).click();
    await page.getByRole('button', { name: t('billing.printBill') }).click();
    await page.getByRole('button', { name: t('billing.pay') }).click();
    await expect(page.getByRole('heading', { name: /^Payment for invoice / })).toBeVisible();
    await page.getByLabel(t('payment.mode')).selectOption({ label: t('payment.modes.UPI') });
    await page.getByRole('button', { name: t('payment.record') }).click();
    await expect(page.getByText(/^Invoice .* is paid$/)).toBeVisible();
    await page.getByRole('button', { name: t('pos.backToTables') }).click();
    await expect(hall.getByRole('button', { name: '3, Free' })).toBeVisible();
  });
});
