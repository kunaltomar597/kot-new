import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FakeRefusal } from './fake-cp.js';
import { INSTALLATION_ID, licence, PENDING_ID, TENANT_ID, tenantDetail } from './fixtures.js';
import { controlPlane, expectNoAxeViolations, renderApp } from './harness.js';

const ACTIVATION = {
  installationId: PENDING_ID,
  code: 'K7QD-M2XP-9WFT-4HNB',
  expiresAt: '2026-10-09T04:00:00.000Z',
};

describe('[VCP-001] [SEC-018] Read-only', () => {
  it('sees restaurants, PCs, licences, notes and QR ordering, and changes nothing', async () => {
    const cp = controlPlane('READ_ONLY');
    cp.on('listSupportNotes', () => ({
      notes: [
        {
          id: '0190a1b2-0000-7000-8000-0000000000e1',
          tenantId: TENANT_ID,
          author: 'vendor:x',
          authorName: 'Ravi',
          body: 'Printer on T4 jams.',
          createdAt: '2026-10-01T06:00:00.000Z',
        },
      ],
    }));
    const { user, container } = renderApp({ cp, path: '/restaurants' });
    expect(await screen.findByRole('link', { name: 'Spice Route' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add restaurant' })).toBeNull();
    await expectNoAxeViolations(container);

    await user.click(screen.getByRole('link', { name: 'Spice Route' }));
    await screen.findByRole('heading', { name: 'Spice Route', level: 1 });
    expect(screen.getByText('27AAPFU0939F1ZV')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit details' })).toBeNull();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('tab', { name: 'PCs' }));
    expect(await screen.findByRole('link', { name: 'Main counter PC' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add PC' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Support notes' }));
    expect(await screen.findByText('Printer on T4 jams.')).toBeVisible();
    expect(screen.getByText(/^Ravi, 01-10-2026 11:30$/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'QR ordering' }));
    expect(await screen.findByText('Not set up for QR ordering yet.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Set up QR ordering' })).toBeNull();

    await user.click(screen.getByRole('tab', { name: 'PCs' }));
    await user.click(await screen.findByRole('link', { name: 'Main counter PC' }));
    await screen.findByRole('heading', { name: 'Main counter PC', level: 1 });
    expect(await screen.findByText('Why: Invoice SUB/2026-27/00001 overdue')).toBeVisible();
    for (const action of [
      'Move to a new PC',
      'Disconnect',
      'Change licence',
      'Reactivation code',
      'Let it bind a new PC',
    ]) {
      expect(screen.queryByRole('button', { name: action })).toBeNull();
    }
    await expectNoAxeViolations(container);
    // Nothing it saw asked for more than it may.
    expect(
      cp.calls.every(
        (call) =>
          call.operationId.startsWith('get') ||
          call.operationId.startsWith('list') ||
          call.operationId === 'vendorMe',
      ),
    ).toBe(true);
  });
});

describe('[VCP-002] [VCP-008] Onboarding', () => {
  it('adds a restaurant, taking its state from the GSTIN, and opens it', async () => {
    const cp = controlPlane('ONBOARDING');
    cp.on('createVendorTenant', ({ body }) => ({
      ...(body as object),
      id: TENANT_ID,
      installations: 0,
      licenceState: null,
      createdAt: '2026-10-02T04:00:00.000Z',
    }));
    const { user } = renderApp({ cp, path: '/restaurants' });
    await user.click(await screen.findByRole('button', { name: 'Add restaurant' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a restaurant' });
    await user.type(within(dialog).getByLabelText('Name'), 'Dosa Corner');
    await user.type(within(dialog).getByLabelText('Contact person'), 'Meera');
    await user.type(within(dialog).getByLabelText(/^GSTIN/), '27AAPFU0939F1ZX');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Not a valid GSTIN')).toBeVisible();
    await user.clear(within(dialog).getByLabelText(/^GSTIN/));
    await user.type(within(dialog).getByLabelText(/^GSTIN/), '27aapfu0939f1zv');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText('Dosa Corner added');
    expect(cp.callsOf('createVendorTenant')[0]?.body).toEqual({
      name: 'Dosa Corner',
      legalName: null,
      gstin: '27AAPFU0939F1ZV',
      stateCode: '27',
      contactName: 'Meera',
      contactEmail: null,
      contactPhone: null,
    });
    await waitFor(() => {
      expect(cp.callsOf('getVendorTenant')).toHaveLength(1);
    });
  });

  it('adds a PC and shows its activation code once; sets up QR ordering', async () => {
    const cp = controlPlane('ONBOARDING');
    cp.on('createVendorInstallation', () => ACTIVATION).on('provisionRelay', () => ({
      tenantId: TENANT_ID,
      provisionedAt: '2026-10-02T04:00:00.000Z',
      credentialIssuedAt: '2026-10-02T04:00:00.000Z',
      delivered: false,
      deliveredAt: null,
    }));
    const { user, container } = renderApp({ cp, path: `/restaurants/${TENANT_ID}` });
    await user.click(await screen.findByRole('tab', { name: 'PCs' }));
    await user.click(screen.getByRole('button', { name: 'Add PC' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a PC' });
    await user.type(within(dialog).getByLabelText(/^Name/), 'Bar PC');
    await user.selectOptions(within(dialog).getByLabelText('Update channel'), 'PILOT');
    await user.click(within(dialog).getByRole('button', { name: 'Add and get the code' }));
    const shown = await screen.findByRole('dialog', { name: 'Activation code' });
    expect(within(shown).getByLabelText('Activation code')).toHaveTextContent(ACTIVATION.code);
    expect(
      within(shown).getByText('Give it to the installer. It works once, until 09-10-2026 09:30.'),
    ).toBeVisible();
    await expectNoAxeViolations(container);
    expect(cp.callsOf('createVendorInstallation')[0]).toMatchObject({
      params: { id: TENANT_ID },
      body: { name: 'Bar PC', channel: 'PILOT' },
    });
    await user.click(within(shown).getByRole('button', { name: 'Done' }));

    await user.click(screen.getByRole('tab', { name: 'QR ordering' }));
    await user.click(await screen.findByRole('button', { name: 'Set up QR ordering' }));
    expect(
      await screen.findByText('QR ordering set up. The PC gets its credential within 5 minutes.'),
    ).toBeVisible();
    expect(cp.callsOf('provisionRelay')).toHaveLength(1);
  });

  it('asks before replacing the QR credential, and edits the details', async () => {
    const cp = controlPlane('ONBOARDING');
    const provisioned = {
      tenantId: TENANT_ID,
      provisionedAt: '2026-09-02T04:00:00.000Z',
      credentialIssuedAt: '2026-09-02T04:00:00.000Z',
      delivered: true,
      deliveredAt: '2026-09-02T04:05:00.000Z',
    };
    cp.on('getRelayProvisioning', () => provisioned)
      .on('provisionRelay', () => ({ ...provisioned, delivered: false, deliveredAt: null }))
      .on('updateVendorTenant', ({ body }) => {
        const { installationList: _list, ...view } = tenantDetail();
        return { ...view, ...(body as object) };
      });
    const { user } = renderApp({ cp, path: `/restaurants/${TENANT_ID}` });
    await user.click(await screen.findByRole('button', { name: 'Edit details' }));
    const edit = await screen.findByRole('dialog', { name: 'Edit the restaurant' });
    await user.clear(within(edit).getByLabelText('Contact phone'));
    await user.type(within(edit).getByLabelText('Contact phone'), '+91 99999 11111');
    await user.click(within(edit).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Details saved')).toBeVisible();
    expect(cp.callsOf('updateVendorTenant')[0]?.body).toMatchObject({
      contactPhone: '+91 99999 11111',
      gstin: '27AAPFU0939F1ZV',
    });

    await user.click(screen.getByRole('tab', { name: 'QR ordering' }));
    expect(await screen.findByText('The PC has its credential')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Issue a new credential' }));
    const confirm = await screen.findByRole('dialog', { name: 'Issue a new credential?' });
    expect(cp.callsOf('provisionRelay')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Issue a new credential' }));
    await waitFor(() => {
      expect(cp.callsOf('provisionRelay')).toHaveLength(1);
    });
  });

  it('gets a new activation code for a PC not activated yet, and disconnects one with a reason', async () => {
    const cp = controlPlane('ONBOARDING');
    cp.on('issueActivationCode', () => ACTIVATION).on('revokeVendorInstallation', () => ({
      ...tenantDetail().installationList[1],
      status: 'REVOKED',
    }));
    const { user } = renderApp({ cp, path: `/installations/${PENDING_ID}` });
    await user.click(await screen.findByRole('button', { name: 'New activation code' }));
    const shown = await screen.findByRole('dialog', { name: 'Activation code' });
    expect(within(shown).getByLabelText('Activation code')).toHaveTextContent(ACTIVATION.code);
    await user.click(within(shown).getByRole('button', { name: 'Done' }));
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    const revoke = await screen.findByRole('dialog', { name: 'Disconnect this PC for good' });
    const confirm = within(revoke).getByRole('button', { name: 'Disconnect' });
    expect(confirm).toBeDisabled();
    await user.type(within(revoke).getByLabelText(/^Reason/), 'Duplicate set-up');
    await user.click(confirm);
    expect(await screen.findByText('PC disconnected')).toBeVisible();
    expect(cp.callsOf('revokeVendorInstallation')[0]?.body).toEqual({ reason: 'Duplicate set-up' });
  });
});

describe('[VCP-007] Support', () => {
  it('writes support notes, but adds nothing else to a restaurant', async () => {
    const cp = controlPlane('SUPPORT');
    const notes: unknown[] = [];
    cp.on('listSupportNotes', () => ({ notes })).on('addSupportNote', ({ body }) => {
      const note = {
        id: '0190a1b2-0000-7000-8000-0000000000e2',
        tenantId: TENANT_ID,
        author: 'vendor:me',
        authorName: 'Asha Rao',
        body: (body as { body: string }).body,
        createdAt: '2026-10-02T04:00:00.000Z',
      };
      notes.unshift(note);
      return note;
    });
    const { user } = renderApp({ cp, path: `/restaurants/${TENANT_ID}` });
    await user.click(await screen.findByRole('tab', { name: 'Support notes' }));
    expect(screen.queryByRole('button', { name: 'Edit details' })).toBeNull();
    expect(await screen.findByText('No notes yet.')).toBeVisible();
    await user.type(screen.getByLabelText(/^New note/), '  Owner asked about pagers.  ');
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    expect(await screen.findByText('Owner asked about pagers.')).toBeVisible();
    expect(cp.callsOf('addSupportNote')[0]?.body).toEqual({ body: 'Owner asked about pagers.' });
    expect(screen.getByLabelText(/^New note/)).toHaveValue('');
    await user.click(screen.getByRole('tab', { name: 'PCs' }));
    expect(screen.queryByRole('button', { name: 'Add PC' })).toBeNull();
  });

  it('[LIC-006] gives a reactivation code; [LIC-004] moves a PC; never changes the licence', async () => {
    const cp = controlPlane('SUPPORT');
    cp.on('createReactivationCode', ({ body }) => ({
      code: 'R3AC-T1V8-ABCD-EFGH',
      validUntil: (body as { until: string }).until,
      counter: 1,
    })).on('moveInstallation', () => ({ ...ACTIVATION, installationId: INSTALLATION_ID }));
    const { user, container } = renderApp({ cp, path: `/installations/${INSTALLATION_ID}` });
    await user.click(await screen.findByRole('button', { name: 'Reactivation code' }));
    expect(screen.queryByRole('button', { name: 'Change licence' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    const dialog = await screen.findByRole('dialog', { name: 'Reactivation code' });
    const until = within(dialog).getByLabelText('Works until');
    await user.clear(until);
    await user.type(until, '2026-10-20');
    await user.click(within(dialog).getByRole('button', { name: 'Create code' }));
    expect(await within(dialog).findByText('R3AC-T1V8-ABCD-EFGH')).toBeVisible();
    expect(
      within(dialog).getByText('Read it to the Owner. It keeps the PC working until 20-10-2026.'),
    ).toBeVisible();
    await expectNoAxeViolations(container);
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));

    await user.click(screen.getByRole('button', { name: 'Move to a new PC' }));
    const move = await screen.findByRole('dialog', { name: 'Move to a new PC' });
    await user.type(within(move).getByLabelText(/^Reason/), 'Old PC failed');
    await user.click(within(move).getByRole('button', { name: 'Move to a new PC' }));
    const shown = await screen.findByRole('dialog', { name: 'Activation code' });
    expect(within(shown).getByLabelText('Activation code')).toHaveTextContent(ACTIVATION.code);
    expect(cp.callsOf('moveInstallation')[0]?.body).toEqual({ reason: 'Old PC failed' });
  });

  it('shows the Control Plane’s refusal and keeps the dialog open', async () => {
    const cp = controlPlane('SUPPORT');
    cp.on('rebindVendorLicence', () => {
      throw new FakeRefusal(409, 'LICENCE_TERMINATED', 'The contract has ended.');
    });
    const { user } = renderApp({ cp, path: `/installations/${INSTALLATION_ID}` });
    await user.click(await screen.findByRole('button', { name: 'Let it bind a new PC' }));
    const dialog = await screen.findByRole('dialog', { name: 'Let the licence bind a new PC' });
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Motherboard replaced');
    await user.click(within(dialog).getByRole('button', { name: 'Let it bind a new PC' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The contract has ended.');
  });
});

describe('[VCP-003] [LIC-005] Finance', () => {
  it('changes a licence with a reason, sending only what changed', async () => {
    const cp = controlPlane('FINANCE');
    cp.on('changeVendorLicence', ({ body }) => ({ ...licence(), ...(body as object) }));
    const { user, container } = renderApp({ cp, path: `/installations/${INSTALLATION_ID}` });
    await user.click(await screen.findByRole('button', { name: 'Change licence' }));
    expect(screen.queryByRole('button', { name: 'Let it bind a new PC' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move to a new PC' })).toBeNull();
    const dialog = await screen.findByRole('dialog', { name: 'Change the licence' });
    const state = within(dialog).getByLabelText('State');
    // From grace the licence may only become active, restricted or terminated (LIC-005).
    expect(
      within(state)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Grace period', 'Restricted', 'Active', 'Terminated']);
    await user.selectOptions(state, 'ACTIVE');
    await user.clear(within(dialog).getByLabelText('Table tablets allowed'));
    await user.type(within(dialog).getByLabelText('Table tablets allowed'), '20');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Paid by NEFT');
    await expectNoAxeViolations(container);
    await user.click(save);
    expect(await screen.findByText('Licence changed')).toBeVisible();
    expect(cp.callsOf('changeVendorLicence')[0]?.body).toEqual({
      state: 'ACTIVE',
      deviceLimits: { TABLE_TABLET: 20, PAGER: 6, WAITER_PHONE: 6, KDS: 2 },
      reason: 'Paid by NEFT',
    });
  });

  it('cannot write notes or set up QR ordering', async () => {
    const cp = controlPlane('FINANCE');
    const { user } = renderApp({ cp, path: `/restaurants/${TENANT_ID}` });
    await user.click(await screen.findByRole('tab', { name: 'Support notes' }));
    expect(await screen.findByText('No notes yet.')).toBeVisible();
    expect(screen.queryByLabelText(/^New note/)).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'QR ordering' }));
    await screen.findByText('Not set up for QR ordering yet.');
    expect(screen.queryByRole('button', { name: 'Set up QR ordering' })).toBeNull();
  });
});

describe('[SEC-018] Super Admin', () => {
  it('has every action on a PC and its licence', async () => {
    const cp = controlPlane('SUPER_ADMIN');
    renderApp({ cp, path: `/installations/${INSTALLATION_ID}` });
    for (const action of [
      'Move to a new PC',
      'Disconnect',
      'Change licence',
      'Reactivation code',
      'Let it bind a new PC',
    ]) {
      expect(await screen.findByRole('button', { name: action })).toBeVisible();
    }
  });
});
