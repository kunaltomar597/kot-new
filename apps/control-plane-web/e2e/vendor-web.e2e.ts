import { expect, test } from '@playwright/test';
import { base32Decode, hotp, totpStep } from '@rp/totp';
import { e2eState } from './state.js';

const PASSWORD = 'correct horse battery staple';

test('[VCP-001] [SEC-018] the first Super Admin sets up MFA, signs in and runs the fleet', async ({
  page,
}) => {
  const { baseUrl, setupToken, email } = e2eState();
  // A Content-Security-Policy violation (or any script error) is logged as an error: none allowed.
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('401')) errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  // The link the CLI printed: a password, then an authenticator proven with a code.
  await page.goto(`${baseUrl}/setup#${setupToken}`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Type the password again').fill(PASSWORD);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(
    page.getByRole('img', { name: 'Code to scan with your authenticator app' }),
  ).toBeVisible();
  const key = (await page.getByLabel('Key for your authenticator app').textContent()) ?? '';
  const secret = base32Decode(key.replace(/\s/g, ''));
  const step = totpStep(new Date());
  await page.getByLabel('Code from the app').fill(hotp(secret, step));
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByText('Your account is ready.')).toBeVisible();
  // The used link is gone from the address bar.
  expect(page.url()).toBe(`${baseUrl}/setup`);

  // Signing in needs all three; a code already used is never accepted again.
  await page.getByRole('link', { name: 'Sign in' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel(/Authenticator code/).fill(hotp(secret, step));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel(/Authenticator code/).fill(hotp(secret, step + 1));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Restaurants', level: 1 })).toBeVisible();

  // Sensitive actions ask for the authenticator again (CP-S2), with a code never used before,
  // not even by the sign-in: as a person would, wait for the app's next code when need be.
  let usedStep = step + 1;
  const freshCode = async (): Promise<string> => {
    const next = usedStep + 1;
    // Accepted from one step early (the window is a step either side).
    await expect
      .poll(() => totpStep(new Date()), { timeout: 35_000, intervals: [1_000] })
      .toBeGreaterThanOrEqual(next - 1);
    usedStep = next;
    return hotp(secret, next);
  };

  // A restaurant, its first PC and a support note.
  await page.getByRole('button', { name: 'Add restaurant' }).click();
  const add = page.getByRole('dialog', { name: 'Add a restaurant' });
  await add.getByLabel('Name', { exact: true }).fill('Spice Route');
  await add.getByLabel(/^GSTIN/).fill('27AAPFU0939F1ZV');
  await add.getByLabel('Contact person').fill('Kiran Shah');
  await add.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Spice Route', level: 1 })).toBeVisible();
  await page.getByRole('tab', { name: 'Details' }).click();
  await expect(page.getByText('27', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'PCs' }).click();
  await page.getByRole('button', { name: 'Add PC' }).click();
  const pc = page.getByRole('dialog', { name: 'Add a PC' });
  await pc.getByLabel(/^Name/).fill('Main counter PC');
  await pc.getByRole('button', { name: 'Add and get the code' }).click();
  const code = page.getByRole('dialog', { name: 'Activation code' });
  await expect(code.getByLabel('Activation code')).toHaveText(/\S{16,}/);
  await code.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('link', { name: 'Main counter PC' })).toBeVisible();

  await page.getByRole('tab', { name: 'Support notes' }).click();
  await page.getByLabel(/^New note/).fill('Onboarding call booked for Monday.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByText('Onboarding call booked for Monday.')).toBeVisible();

  // The fleet: the new PC is waiting for its installer, and nothing needs looking at.
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name: 'Fleet' })
    .click();
  await expect(page.getByText('No open alerts. Every PC looks fine.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Spice Route: Main counter PC' })).toBeVisible();

  // A second staff member gets a one-time setup link.
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name: 'Staff' })
    .click();
  await page.getByRole('button', { name: 'Add staff member' }).click();
  const staff = page.getByRole('dialog', { name: 'Add a staff member' });
  await staff.getByLabel('Email').fill('ravi@vendor.example');
  await staff.getByLabel('Name').fill('Ravi Kumar');
  await staff.getByLabel(/^Role/).selectOption('SUPPORT');
  await staff.getByRole('button', { name: 'Add staff member' }).click();
  const confirm = page.getByRole('dialog', { name: 'Confirm with your authenticator' });
  await confirm.getByLabel('Authenticator code').fill(await freshCode());
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Setup link for Ravi Kumar' }).getByLabel('Setup link'),
  ).toHaveText(new RegExp(`^${baseUrl}/setup#[A-Za-z0-9_-]{43}$`));
  await page.getByRole('button', { name: 'Done' }).click();

  // Everything above is in the audit log.
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name: 'Audit log' })
    .click();
  for (const action of [
    'tenant.created',
    'support.note_added',
    'vendor.user_created',
    'vendor.signed_in',
  ]) {
    await expect(page.getByRole('cell', { name: action, exact: true }).first()).toBeVisible();
  }
  await expect(
    page.getByRole('cell', { name: 'vendor.sign_in_failed', exact: true }),
  ).toBeVisible();

  // Signing out ends the session for good in this tab.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.goto(`${baseUrl}/audit`);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('[SEC-003] the pages carry a strict Content-Security-Policy', async ({ request }) => {
  const { baseUrl } = e2eState();
  const page = await request.get(`${baseUrl}/restaurants`, { headers: { accept: 'text/html' } });
  expect(page.headers()['content-security-policy']).toContain("default-src 'self'");
  // Trusted Types (P8-03c1): the run above, with every page, logged no violation of them.
  expect(page.headers()['content-security-policy']).toContain("trusted-types 'none'");
  expect(page.headers()['x-robots-tag']).toBe('noindex, nofollow');
});
