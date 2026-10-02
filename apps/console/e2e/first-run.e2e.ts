import { expect, test } from '@playwright/test';
import { createTranslator } from '@rp/i18n';
import { startServer } from './server.js';

const t = createTranslator();

/**
 * P7-07b acceptance (ONB-001, ONB-004, ONB-009): a fresh install, from an empty database to the
 * Owner on the set-up page, as the restaurant would do it on its PC. Timings go into the report
 * as annotations; docs/build/onboarding-timing.md keeps the figures.
 */
test('[ONB-001] [ONB-004] [ONB-009] a fresh install: restaurant and Owner, then the set-up page', async ({
  browser,
}) => {
  const databaseUrl = process.env.RP_E2E_FRESH_DATABASE_URL;
  const dataDir = process.env.RP_E2E_FRESH_DATA_DIR;
  if (databaseUrl === undefined || dataDir === undefined) throw new Error('Run through Playwright');
  const server = await startServer(undefined, { databaseUrl, dataDir });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const started = Date.now();
    await page.goto(server.url);
    await expect(page).toHaveURL(/\/pair$/);
    await expect(page.getByRole('heading', { name: t('firstRun.title') })).toBeVisible();
    await page.getByLabel(t('firstRun.restaurantName'), { exact: false }).fill('Spice Route');
    await page.getByLabel(t('firstRun.ownerName')).fill('Asha Rao');
    await page.getByLabel(new RegExp(`^${t('firstRun.pin')}`)).fill('4829');
    await page.getByLabel(t('firstRun.repeatPin')).fill('4829');
    await page.getByRole('button', { name: t('firstRun.create') }).click();

    // Paired by itself: the Owner signs in with the PIN just chosen.
    await expect(page.getByRole('heading', { name: t('login.title') })).toBeVisible();
    await page.getByRole('button', { name: /^Asha Rao/ }).click();
    await page.keyboard.type('4829');
    await expect(page).toHaveURL(/\/manage$/);
    const signedIn = Date.now();
    await expect(page.getByText(t('setupPage.banner', { finished: 0, total: 11 }))).toBeVisible();

    await page.getByRole('link', { name: t('setupPage.continue') }).click();
    await expect(page.getByRole('heading', { name: t('setupPage.title') })).toBeVisible();
    await expect(page.getByText(t('setupPage.progress', { finished: 0, total: 11 }))).toBeVisible();
    // The default invoice series exists: the Owner confirms how invoices look.
    await page.getByRole('button', { name: t('setupPage.step.INVOICE.confirm') }).click();
    await expect(page.getByText(t('setupPage.progress', { finished: 1, total: 11 }))).toBeVisible();
    test.info().annotations.push({
      type: 'timing',
      description: `Empty database to the Owner signed in: ${String(signedIn - started)} ms; to the first confirmed step: ${String(Date.now() - started)} ms.`,
    });
  } finally {
    await context.close();
    await server.stop();
  }
});
