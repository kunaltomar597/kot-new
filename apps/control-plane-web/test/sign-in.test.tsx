import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FakeRefusal } from './fake-cp.js';
import { meView } from './fixtures.js';
import { controlPlane, expectNoAxeViolations, renderApp } from './harness.js';

describe('signing in', () => {
  it('[VCP-001] [SEC-018] needs email, password and the authenticator code together', async () => {
    const cp = controlPlane();
    cp.on('vendorSignIn', ({ body }) => {
      const { code } = body as { code: string };
      if (code !== '246810') {
        throw new FakeRefusal(401, 'VENDOR_SIGN_IN_FAILED', 'Wrong email, password or code.');
      }
      cp.role = 'SUPPORT';
      const me = meView('SUPPORT');
      return { token: 'new-token', ...me };
    });
    const { user, storage, container } = renderApp({ cp });
    await screen.findByRole('heading', { name: 'Vendor Control Plane' });
    await expectNoAxeViolations(container);
    const submit = screen.getByRole('button', { name: 'Sign in' });
    await user.type(screen.getByLabelText('Email'), 'asha@vendor.example');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/Authenticator code/), '111111');
    await user.click(submit);
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong email, password or code.');
    expect(screen.getByLabelText(/Authenticator code/)).toHaveValue('');

    await user.type(screen.getByLabelText(/Authenticator code/), '246810');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Restaurants', level: 1 })).toBeVisible();
    expect(storage.value).toBe('new-token');
    const header = screen.getByRole('banner');
    expect(within(header).getByText('Asha Rao')).toBeVisible();
    expect(within(header).getByText('Support')).toBeVisible();
  });

  it('[VCP-001] keeps the session across a reload, and signs out', async () => {
    const cp = controlPlane('READ_ONLY');
    const { user, storage } = renderApp({ cp, path: '/restaurants' });
    expect(await screen.findByRole('link', { name: 'Spice Route' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(cp.callsOf('vendorSignOut')).toHaveLength(1);
    expect(storage.value).toBeUndefined();
    expect(screen.queryByText('Your session ended. Sign in again.')).toBeNull();
  });

  it('[SEC-018] goes back to signing in when the Control Plane ends the session', async () => {
    const cp = controlPlane('FINANCE');
    const { user } = renderApp({ cp, path: '/restaurants' });
    await screen.findByRole('link', { name: 'Spice Route' });
    // Idle for 30 minutes: the next call is refused.
    cp.role = undefined;
    await user.click(screen.getByRole('link', { name: 'Spice Route' }));
    expect(await screen.findByText('Your session ended. Sign in again.')).toBeVisible();
  });

  it('[VCP-001] shows signing in when a stored session is no longer good', async () => {
    const cp = controlPlane();
    renderApp({ cp, path: '/restaurants', signedIn: true });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeVisible();
    await waitFor(() => {
      expect(cp.callsOf('vendorMe')).toHaveLength(1);
    });
  });
});
