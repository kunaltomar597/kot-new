import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { draftOf, valuesOf } from '../src/remote/remote-form.js';
import { INSTALLATION_ID, REMOTE_DEFINITIONS } from './fixtures.js';
import { controlPlane, expectNoAxeViolations, renderApp } from './harness.js';

describe('[UPD-010] remote settings in the web app', () => {
  it('shows every role the values; only the Super Admin changes them, with a reason', async () => {
    const readOnly = renderApp({ cp: controlPlane('READ_ONLY'), path: '/remote-settings' });
    expect(await screen.findByText('qr.pickupTimeoutSeconds')).toBeVisible();
    expect(screen.getByText('60 seconds')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Change for every PC' })).toBeNull();
    readOnly.unmount();

    const cp = controlPlane('SUPER_ADMIN').on('setFleetRemoteSettings', ({ body }) => ({
      definitions: REMOTE_DEFINITIONS,
      fleet: (body as { values: object }).values,
      updatedAt: '2026-10-02T10:00:00.000Z',
    }));
    const { user, container } = renderApp({ cp, path: '/remote-settings' });
    await user.click(await screen.findByRole('button', { name: 'Change for every PC' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change the settings for every PC' });
    const number = within(dialog).getByLabelText(/^qr\.pickupTimeoutSeconds/);
    await user.type(number, '5');
    await user.selectOptions(within(dialog).getByLabelText(/^features\.aiMenuImport/), 'false');
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Pilot tuning');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByText('Not a value this setting allows.')).toBeVisible();
    expect(cp.callsOf('setFleetRemoteSettings')).toHaveLength(0);
    await expectNoAxeViolations(container);
    await user.clear(number);
    await user.type(number, '90');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved. PCs get it with their next heartbeat.')).toBeVisible();
    expect(cp.callsOf('setFleetRemoteSettings')[0]?.body).toEqual({
      values: { 'qr.pickupTimeoutSeconds': 90, 'features.aiMenuImport': false },
      reason: 'Pilot tuning',
    });
  });

  it('shows a PC’s own values and whether it holds them', async () => {
    const cp = controlPlane('SUPER_ADMIN')
      .on('getInstallationRemoteSettings', () => ({
        installationId: INSTALLATION_ID,
        fleet: { 'qr.pickupTimeoutSeconds': 90 },
        overrides: { 'features.aiMenuImport': false },
        effective: { 'qr.pickupTimeoutSeconds': 90, 'features.aiMenuImport': false },
        digest: '1111111111111111',
        appliedDigest: '0000000000000000',
        updatedAt: '2026-10-02T10:00:00.000Z',
      }))
      .on('setInstallationRemoteSettings', ({ body }) => ({
        installationId: INSTALLATION_ID,
        fleet: {},
        overrides: (body as { values: object }).values,
        effective: (body as { values: object }).values,
        digest: '2222222222222222',
        appliedDigest: '0000000000000000',
        updatedAt: '2026-10-02T10:05:00.000Z',
      }));
    const { user } = renderApp({ cp, path: `/installations/${INSTALLATION_ID}` });
    expect(await screen.findByText('Waiting for the PC to collect them')).toBeVisible();
    expect(screen.getByText('Off')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Change for this PC' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change this PC’s own settings' });
    await user.selectOptions(within(dialog).getByLabelText(/^features\.aiMenuImport/), '');
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Provider back');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved. PCs get it with their next heartbeat.')).toBeVisible();
    expect(cp.callsOf('setInstallationRemoteSettings')[0]?.body).toEqual({
      values: {},
      reason: 'Provider back',
    });
  });

  it('turns the editor’s text into values', () => {
    expect(draftOf(REMOTE_DEFINITIONS, { 'features.aiMenuImport': false })).toEqual({
      'qr.pickupTimeoutSeconds': '',
      'features.aiMenuImport': 'false',
    });
    expect(
      valuesOf(REMOTE_DEFINITIONS, {
        'qr.pickupTimeoutSeconds': ' 600 ',
        'features.aiMenuImport': 'true',
      }),
    ).toEqual({
      values: { 'qr.pickupTimeoutSeconds': 600, 'features.aiMenuImport': true },
      invalid: [],
    });
    expect(valuesOf(REMOTE_DEFINITIONS, { 'qr.pickupTimeoutSeconds': '601' }).invalid).toEqual([
      'qr.pickupTimeoutSeconds',
    ]);
  });
});
