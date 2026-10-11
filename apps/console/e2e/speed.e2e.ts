import { expect, type Locator, type Page, test } from '@playwright/test';
import { createTranslator } from '@rp/i18n';
import { type RunningServer, startServer } from './server.js';

/**
 * NFR-P07 (P8-01b): a tap shows its answer within 100 ms and a screen changes within 300 ms. The
 * console runs on a restaurant of the design capacity's size (1,000 dishes, 100 tables; global
 * setup), on a browser slowed down to the reference device (the build Mac four times slower; see
 * `REFERENCE_SCORE`), through a cashier's order, the kitchen's ticket and a manager's walk through
 * the dashboard. The browser measures itself:
 *
 * - a tap: the longest event of the interaction (pointerdown, pointerup, click), from the input
 *   until the next frame was painted (Event Timing). Under 16 ms the browser does not report it;
 *   it counts as 16 ms.
 * - a screen change: from the tap's input until a frame shows a heading the screen did not have
 *   ("shown"), and until that screen has nothing loading any more ("ready", for the record).
 *
 * The figures are printed for `docs/build/performance.md`.
 */

const t = createTranslator();

/**
 * The reference device's speed in `benchmark` rounds a second: the build Mac, where the budgets
 * were first measured, with its CPU slowed down 4 times (Lighthouse's mobile setting; the
 * restaurant PC and kitchen screens are slower than the Mac). Measured 2026-10-11: about 8,600
 * unthrottled on the Mac, 2,118 slowed down 4 times. Each machine slows the browser by its own
 * score over this one, as Lighthouse scales its slowdown by its benchmark index, so a CI runner
 * three times slower than the Mac measures the same device rather than one twelve times slower.
 */
const REFERENCE_SCORE = 2_150;
const TAP_BUDGET_MS = 100;
const SCREEN_BUDGET_MS = 300;

interface SpeedProbe {
  /** Events of interactions slower than 16 ms, in the order the browser reported them. */
  readonly events: { name: string; duration: number }[];
  /** When the last pointerdown happened (`event.timeStamp`). */
  downAt: number;
}

/** Runs in the page: rounds a second of fixed work (strings, an array, a sort), median of five. */
function benchmark(): number {
  const scores: number[] = [];
  for (let run = 0; run < 5; run += 1) {
    const start = performance.now();
    let rounds = 0;
    while (performance.now() - start < 100) {
      let text = '';
      for (let i = 0; i < 2000; i += 1) text += String.fromCharCode(97 + (i % 26));
      const numbers: number[] = [];
      for (let i = 0; i < 2000; i += 1) numbers.push((i * 7919) % 2003);
      numbers.sort((a, b) => a - b);
      if (text.length + (numbers[0] ?? 0) < 0) throw new Error('unreachable');
      rounds += 1;
    }
    scores.push((rounds * 1000) / (performance.now() - start));
  }
  scores.sort((a, b) => a - b);
  return scores[2] ?? 0;
}

/** Runs in the page before its own scripts: records the input and the browser's Event Timing. */
function probe(): void {
  const speed: SpeedProbe = { events: [], downAt: 0 };
  (window as unknown as { rpSpeed: SpeedProbe }).rpSpeed = speed;
  addEventListener(
    'pointerdown',
    (event) => {
      speed.downAt = event.timeStamp;
    },
    { capture: true },
  );
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const { interactionId, duration, name } = entry as PerformanceEntry & {
        interactionId?: number;
      };
      if ((interactionId ?? 0) > 0) speed.events.push({ name, duration });
    }
  }).observe({ type: 'event', durationThreshold: 16, buffered: true } as PerformanceObserverInit);
}

interface Summary {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/** Nearest-rank percentiles, as the load test's (P8-01a). */
function summarise(values: readonly number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
  return { count: sorted.length, p50: at(50), p95: at(95), max: sorted.at(-1) ?? 0 };
}

class Speed {
  readonly taps: { readonly what: string; readonly ms: number }[] = [];
  readonly screens: { readonly what: string; readonly shown: number; readonly ready: number }[] =
    [];

  constructor(private readonly page: Page) {}

  /** Taps `target` and records how long the browser took to answer it. */
  async tap(what: string, target: Locator): Promise<void> {
    const from = await this.settled();
    await target.click();
    this.taps.push({ what, ms: await this.longestSince(from) });
  }

  /** Taps `target`, which changes the screen, and records the tap and the change. */
  async go(what: string, target: Locator): Promise<void> {
    const from = await this.settled();
    await this.page.evaluate(() => {
      for (const heading of document.querySelectorAll('h1, h2')) {
        heading.setAttribute('data-speed-seen', '');
      }
    });
    const arrived = this.page.evaluate(
      () =>
        new Promise<{ shown: number; ready: number }>((resolve, reject) => {
          let shown: number | undefined;
          const deadline = performance.now() + 20_000;
          const look = () => {
            const now = performance.now();
            const fresh = [...document.querySelectorAll('h1, h2')].some(
              (heading) => !heading.hasAttribute('data-speed-seen'),
            );
            if (fresh) shown ??= now;
            if (shown !== undefined && document.querySelector('[data-kind="loading"]') === null) {
              resolve({ shown, ready: now });
            } else if (now > deadline) {
              reject(new Error('The screen did not change'));
            } else {
              requestAnimationFrame(look);
            }
          };
          requestAnimationFrame(look);
        }),
    );
    await target.click();
    const { shown, ready } = await arrived;
    const downAt = await this.page.evaluate(
      () => (window as unknown as { rpSpeed: SpeedProbe }).rpSpeed.downAt,
    );
    this.screens.push({ what, shown: shown - downAt, ready: ready - downAt });
    this.taps.push({ what, ms: await this.longestSince(from) });
  }

  /** Waits for the frames after what came before to be painted and reported. */
  private async settled(): Promise<number> {
    await this.page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              setTimeout(resolve, 100);
            }),
          );
        }),
    );
    return this.page.evaluate(
      () => (window as unknown as { rpSpeed: SpeedProbe }).rpSpeed.events.length,
    );
  }

  private async longestSince(from: number): Promise<number> {
    await this.settled();
    const durations = await this.page.evaluate(
      (start) =>
        (window as unknown as { rpSpeed: SpeedProbe }).rpSpeed.events
          .slice(start)
          .map((event) => event.duration),
      from,
    );
    return Math.max(16, ...durations);
  }
}

test.describe.serial('[NFR-P07] taps and screen changes at the design capacity’s size', () => {
  let server: RunningServer;

  test.beforeAll(async () => {
    const databaseUrl = process.env.RP_E2E_SPEED_DATABASE_URL;
    const dataDir = process.env.RP_E2E_SPEED_DATA_DIR;
    if (databaseUrl === undefined || dataDir === undefined) throw new Error('No speed database');
    server = await startServer(undefined, { databaseUrl, dataDir });
  });

  test.afterAll(async () => {
    await server.stop();
  });

  test('answers taps within 100 ms and changes screens within 300 ms', async ({ page }) => {
    test.setTimeout(300_000);
    await page.addInitScript(probe);
    const pinKey = (digit: string) => page.getByRole('button', { name: digit, exact: true });
    const signOut = page.getByRole('button', { name: t('login.signOut') });

    // Set-up, not measured: pair this browser, then a manager publishes the 1,000 dishes.
    const bootstrap = await fetch(`${server.url}/api/v1/devices/pairing-codes/bootstrap`, {
      method: 'POST',
    });
    const { code } = (await bootstrap.json()) as { code: string };
    await page.goto(server.url);
    await page.getByLabel(t('pairing.codeLabel')).fill(code);
    await page.getByRole('button', { name: t('pairing.submit') }).click();
    await expect(page.getByRole('heading', { name: t('login.title') })).toBeVisible();
    await page.getByRole('button', { name: /^Vikram \(Manager\)/ }).click();
    await expect(
      page.getByRole('heading', { name: t('login.pinFor', { name: 'Vikram (Manager)' }) }),
    ).toBeVisible();
    await page.keyboard.type('2222');
    await expect(page).toHaveURL(/\/manage$/);
    await page.goto(`${server.url}/manage/menu`);
    await page.getByRole('button', { name: t('menuEditor.publish') }).click();
    await expect(page.getByText(/^Menu version \d+ is published/)).toBeVisible();
    await signOut.click();
    await expect(page.getByRole('heading', { name: t('login.title') })).toBeVisible();

    // The reference device on every machine; one slower than it runs unthrottled.
    const score = await page.evaluate(benchmark);
    const slowdown = Math.max(1, score / REFERENCE_SCORE);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: slowdown });
    const speed = new Speed(page);
    const signIn = async (name: RegExp, pin: string, mode: string) => {
      await speed.tap('sign-in tile', page.getByRole('button', { name }));
      for (const digit of pin.slice(0, -1)) await speed.tap('PIN key', pinKey(digit));
      await speed.go(`PIN → ${mode}`, pinKey(pin.slice(-1)));
    };

    // A cashier seats table 11 and sends ten dishes from five sections of the menu.
    await signIn(/^Neha \(Cashier\)/, '3333', 'POS');
    await speed.tap('a free table', page.getByRole('button', { name: '11, Free' }));
    const open = page.getByRole('dialog', { name: t('pos.open.title', { table: '11' }) });
    await open.getByLabel(t('pos.open.guests'), { exact: true }).fill('2');
    await speed.tap('open the table', open.getByRole('button', { name: t('pos.open.submit') }));
    await expect(page.getByText(t('pos.open.opened', { table: '11' }))).toBeVisible();
    await speed.tap('an occupied table', page.getByRole('button', { name: /^11, Occupied/ }));
    await speed.go(
      'table → its order',
      page.getByRole('button', { name: t('pos.table.takeOrder') }),
    );
    for (const section of [1, 2, 3, 4, 5]) {
      await speed.tap(
        'a menu section',
        page.getByRole('button', { name: `Section ${String(section)}`, exact: true }),
      );
      for (const dish of [section + 19, section + 39]) {
        await speed.tap(
          'a dish',
          page.getByRole('button', { name: new RegExp(`^Dish ${String(dish)}, `) }),
        );
      }
    }
    const cart = page.getByRole('complementary', { name: t('pos.cart.title') });
    await speed.tap('send', cart.getByRole('button', { name: t('pos.cart.send') }));
    await expect(page.getByText(/^Order \d+ sent to the kitchen$/)).toBeVisible();
    await speed.go('order → the floor', page.getByRole('button', { name: t('pos.backToTables') }));
    await speed.go('sign out', signOut);

    // The kitchen cooks the ticket and bumps it.
    await signIn(/^Chef Imran/, '6666', 'the kitchen display');
    const ticket = page.getByRole('article', { name: /^KOT \d+, Table 11$/ });
    await speed.tap('all preparing', ticket.getByRole('button', { name: t('kds.allPreparing') }));
    await speed.tap('all ready', ticket.getByRole('button', { name: t('kds.allReady') }));
    await speed.tap('bump', ticket.getByRole('button', { name: /^Bump KOT/ }));
    await expect(ticket).toHaveCount(0);
    await speed.go('sign out', signOut);

    // A manager walks through the dashboard.
    await signIn(/^Vikram \(Manager\)/, '2222', 'the dashboard');
    const nav = page.getByRole('navigation', { name: t('dashboard.navigation') });
    for (const section of [
      'orders',
      'alerts',
      'reports',
      'staff',
      'floor',
      'menu',
      'devices',
      'settings',
      'system',
      'overview',
    ] as const) {
      await speed.go(
        `dashboard: ${section}`,
        nav.getByRole('link', { name: t(`dashboard.section.${section}`), exact: true }),
      );
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

    const taps = summarise(speed.taps.map((entry) => entry.ms));
    const shown = summarise(speed.screens.map((entry) => entry.shown));
    const ready = summarise(speed.screens.map((entry) => entry.ready));
    const slowest = [...speed.taps].sort((a, b) => b.ms - a.ms).slice(0, 3);
    const line = (summary: Summary) =>
      `${String(summary.count)} samples, p50 ${String(Math.round(summary.p50))} ms, p95 ${String(Math.round(summary.p95))} ms, max ${String(Math.round(summary.max))} ms`;
    // eslint-disable-next-line no-console -- the measured figures, for the CI log and performance.md.
    console.log(
      [
        `NFR-P07 on the reference device: this machine scores ${String(Math.round(score))} (the reference ${String(REFERENCE_SCORE)}), CPU slowed down ${slowdown.toFixed(2)} times`,
        `taps: ${line(taps)}; slowest ${slowest.map((entry) => `${entry.what} ${String(Math.round(entry.ms))} ms`).join(', ')}`,
        `screens shown: ${line(shown)}`,
        `screens ready: ${line(ready)}`,
        ...speed.screens.map(
          (entry) =>
            `  ${entry.what}: shown ${String(Math.round(entry.shown))} ms, ready ${String(Math.round(entry.ready))} ms`,
        ),
      ].join('\n'),
    );
    expect(taps.p95).toBeLessThanOrEqual(TAP_BUDGET_MS);
    expect(shown.p95).toBeLessThanOrEqual(SCREEN_BUDGET_MS);
  });
});
