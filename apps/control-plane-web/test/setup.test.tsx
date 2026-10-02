import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { groupSecret } from '../src/screens/SetupScreen.js';
import { FakeRefusal } from './fake-cp.js';
import { vendorUser } from './fixtures.js';
import { controlPlane, expectNoAxeViolations, renderApp } from './harness.js';

const TOKEN = 'A'.repeat(40) + '_-9';

describe('setting up an account', () => {
  it('[VCP-001] [SEC-018] sets a password, then adds an authenticator proven with a code', async () => {
    const cp = controlPlane();
    cp.on('vendorSetup', ({ body }) => {
      expect(body).toEqual({ token: TOKEN, password: 'a long enough password' });
      return {
        otpauthUri: 'otpauth://totp/Vendor:asha?secret=JBSWY3DPEHPK3PXP',
        secret: 'JBSWY3DPEHPK3PXP',
      };
    }).on('vendorSetupConfirm', ({ body }) => {
      if ((body as { code: string }).code !== '135790') {
        throw new FakeRefusal(401, 'VENDOR_SETUP_INVALID', 'That code is not right.');
      }
      return vendorUser('SUPPORT');
    });
    const { user, container } = renderApp({ cp, path: `/setup#${TOKEN}` });
    await screen.findByRole('heading', { name: 'Set up your account' });
    await user.type(screen.getByLabelText('Password'), 'too short');
    expect(screen.getByText('Use at least 12 characters.')).toBeVisible();
    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), 'a long enough password');
    await user.type(screen.getByLabelText('Type the password again'), 'a long enough passw0rd');
    expect(screen.getByText('The passwords are not the same.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.clear(screen.getByLabelText('Type the password again'));
    await user.type(screen.getByLabelText('Type the password again'), 'a long enough password');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(
      await screen.findByRole('img', { name: 'Code to scan with your authenticator app' }),
    ).toBeVisible();
    expect(screen.getByLabelText('Key for your authenticator app')).toHaveTextContent(
      'JBSW Y3DP EHPK 3PXP',
    );
    await expectNoAxeViolations(container);
    await user.type(screen.getByLabelText('Code from the app'), '000000');
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not right.');
    await user.clear(screen.getByLabelText('Code from the app'));
    await user.type(screen.getByLabelText('Code from the app'), '135790');
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByText('Your account is ready.')).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'Sign in' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  it('[VCP-001] says when the link is not a setup link', async () => {
    renderApp({ cp: controlPlane(), path: '/setup#nope' });
    expect(
      await screen.findByText('This setup link is not valid. Ask your Super Admin for a new one.'),
    ).toBeVisible();
  });

  it('groups the key in fours for typing by hand', () => {
    expect(groupSecret('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
    expect(groupSecret('ABCDEFGH')).toBe('ABCD EFGH');
  });
});
