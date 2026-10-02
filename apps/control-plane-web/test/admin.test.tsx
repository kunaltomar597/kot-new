import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { detailsText } from '../src/audit/AuditScreen.js';
import { megabytes, releaseRequestOf } from '../src/releases/ReleasesScreen.js';
import { accountStatus, setupLink } from '../src/staff/StaffScreen.js';
import { vendorUser } from './fixtures.js';
import { controlPlane, expectNoAxeViolations, renderApp } from './harness.js';

const RELEASE = {
  component: 'RESTAURANT_PC',
  channel: 'STABLE',
  version: '1.4.0',
  url: 'https://downloads.example/rp-1.4.0.exe',
  sha256: 'a'.repeat(64),
  sizeBytes: 157_286_400,
  notes: 'Floor plan',
  publishedAt: '2026-09-20T05:00:00.000Z',
} as const;

const entry = (id: number, action = 'licence.changed') => ({
  id: String(id),
  at: '2026-10-01T05:00:00.000Z',
  actor: 'vendor:0190a1b2-0000-7000-8000-0000000000aa',
  action,
  targetType: 'installation',
  targetId: '0190a1b2-0000-7000-8000-000000000002',
  details: { reason: 'Paid', state: 'ACTIVE' },
});

describe('[VCP-001] [SEC-003] sections by role', () => {
  it.each([
    ['READ_ONLY', ['Restaurants', 'Fleet', 'Invoices', 'Plans', 'Releases', 'Remote settings']],
    ['SUPPORT', ['Restaurants', 'Fleet', 'Invoices', 'Plans', 'Releases', 'Remote settings']],
    [
      'FINANCE',
      ['Restaurants', 'Fleet', 'Invoices', 'Plans', 'Releases', 'Remote settings', 'Audit log'],
    ],
    [
      'SUPER_ADMIN',
      [
        'Restaurants',
        'Fleet',
        'Invoices',
        'Plans',
        'Releases',
        'Remote settings',
        'Audit log',
        'Staff',
      ],
    ],
  ] as const)('%s sees %j', async (role, sections) => {
    renderApp({ cp: controlPlane(role), path: '/restaurants' });
    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(sections);
  });

  it('says so when a role opens a page it may not use, and asks the server nothing', async () => {
    const cp = controlPlane('SUPPORT');
    renderApp({ cp, path: '/staff' });
    expect(await screen.findByText('Your role does not allow this page.')).toBeVisible();
    expect(cp.callsOf('listVendorUsers')).toHaveLength(0);
  });
});

describe('[VCP-006] releases', () => {
  it('lists releases for everyone; only the Super Admin publishes, checked first', async () => {
    const finance = controlPlane('FINANCE').on('listVendorReleases', () => ({
      releases: [RELEASE],
    }));
    const seen = renderApp({ cp: finance, path: '/releases' });
    expect(await screen.findByText('1.4.0')).toBeVisible();
    expect(screen.getByText('150.0 MB')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Publish release' })).toBeNull();
    await expectNoAxeViolations(seen.container);
    seen.unmount();

    const cp = controlPlane('SUPER_ADMIN')
      .on('listVendorReleases', () => ({ releases: [RELEASE] }))
      .on('publishVendorRelease', ({ body }) => ({ ...RELEASE, ...(body as object) }));
    const { user } = renderApp({ cp, path: '/releases' });
    await user.click(await screen.findByRole('button', { name: 'Publish release' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish a release' });
    await user.type(within(dialog).getByLabelText(/^Version/), '1.5.0-beta.1');
    await user.type(
      within(dialog).getByLabelText(/^Download address/),
      'http://insecure.example/x.exe',
    );
    await user.type(within(dialog).getByLabelText(/^SHA-256/), 'B'.repeat(64));
    await user.type(within(dialog).getByLabelText('Size in bytes'), '1024');
    await user.click(within(dialog).getByRole('button', { name: 'Publish release' }));
    expect(cp.callsOf('publishVendorRelease')).toHaveLength(0);
    await user.clear(within(dialog).getByLabelText(/^Download address/));
    await user.type(
      within(dialog).getByLabelText(/^Download address/),
      'https://downloads.example/rp-1.5.0-beta.1.exe',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Publish release' }));
    expect(await screen.findByText('Release published')).toBeVisible();
    expect(cp.callsOf('publishVendorRelease')[0]?.body).toEqual({
      component: 'RESTAURANT_PC',
      channel: 'PILOT',
      version: '1.5.0-beta.1',
      url: 'https://downloads.example/rp-1.5.0-beta.1.exe',
      sha256: 'b'.repeat(64),
      sizeBytes: 1024,
      notes: null,
    });
  });

  it('reads sizes and checks the request', () => {
    expect(megabytes(1_572_864)).toBe('1.5');
    const draft = {
      channel: 'STABLE',
      version: '1.0.0',
      url: 'https://x.example/a',
      sha256: 'f'.repeat(64),
      sizeBytes: '12x',
      notes: '',
    } as const;
    expect(releaseRequestOf(draft).success).toBe(false);
    expect(releaseRequestOf({ ...draft, sizeBytes: '12' }).success).toBe(true);
  });
});

describe('[SEC-018] [AUD-001] the audit log', () => {
  it('shows Finance every action, filtered, fifty at a time', async () => {
    const first = Array.from({ length: 50 }, (_, index) => entry(200 - index));
    const cp = controlPlane('FINANCE').on('listVendorAudit', ({ query }) =>
      query.before === undefined ? { entries: first } : { entries: [entry(100, 'tenant.created')] },
    );
    const { user, container } = renderApp({ cp, path: '/audit' });
    expect(await screen.findAllByText('licence.changed')).toHaveLength(50);
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: 'Show older' }));
    expect(await screen.findByText('tenant.created')).toBeVisible();
    expect(cp.callsOf('listVendorAudit').at(-1)?.query).toEqual({ before: '151', limit: '50' });
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();

    await user.type(screen.getByLabelText(/^Action/), 'Licence Changed');
    expect(screen.getByText('Use lower-case letters, dots and _ only.')).toBeVisible();
    await user.clear(screen.getByLabelText(/^Action/));
    await user.type(screen.getByLabelText(/^Action/), 'licence.changed');
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() => {
      expect(cp.callsOf('listVendorAudit').at(-1)?.query).toEqual({
        action: 'licence.changed',
        limit: '50',
      });
    });
  });

  it('writes details as one line', () => {
    expect(detailsText({ reason: 'Paid' })).toBe('{"reason":"Paid"}');
    expect(detailsText(null)).toBe('');
  });
});

describe('[VCP-001] [SEC-018] staff accounts', () => {
  const OTHER = '0190a1b2-0000-7000-8000-0000000000ab';
  const users = () => ({
    users: [
      vendorUser('SUPER_ADMIN'),
      vendorUser('SUPPORT', { id: OTHER, name: 'Ravi Kumar', email: 'ravi@vendor.example' }),
      vendorUser('READ_ONLY', {
        id: '0190a1b2-0000-7000-8000-0000000000ac',
        name: 'New Person',
        email: 'new@vendor.example',
        active: false,
        lastSignInAt: null,
      }),
    ],
  });

  it('adds a staff member and shows their setup link once', async () => {
    const cp = controlPlane('SUPER_ADMIN')
      .on('listVendorUsers', users)
      .on('createVendorUser', ({ body }) => ({
        user: vendorUser('ONBOARDING', { id: OTHER, ...(body as object), active: false }),
        setupToken: 'T'.repeat(43),
        setupExpiresAt: '2026-10-05T04:00:00.000Z',
      }));
    const { user, container } = renderApp({ cp, path: '/staff' });
    expect(await screen.findByText('Waiting for setup')).toBeVisible();
    expect(screen.getByText('You')).toBeVisible();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: 'Add staff member' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a staff member' });
    await user.type(within(dialog).getByLabelText('Email'), 'Meena@Vendor.example');
    await user.type(within(dialog).getByLabelText('Name'), 'Meena');
    await user.selectOptions(within(dialog).getByLabelText(/^Role/), 'ONBOARDING');
    await user.click(within(dialog).getByRole('button', { name: 'Add staff member' }));
    const shown = await screen.findByRole('dialog', { name: 'Setup link for Meena' });
    expect(within(shown).getByLabelText('Setup link')).toHaveTextContent(
      `${globalThis.location.origin}/setup#${'T'.repeat(43)}`,
    );
    expect(cp.callsOf('createVendorUser')[0]?.body).toEqual({
      email: 'meena@vendor.example',
      name: 'Meena',
      role: 'ONBOARDING',
    });
  });

  it('changes a role with a reason and resets a lost authenticator', async () => {
    const cp = controlPlane('SUPER_ADMIN')
      .on('listVendorUsers', users)
      .on('updateVendorUser', ({ body }) =>
        vendorUser('FINANCE', { id: OTHER, ...(body as object) }),
      )
      .on('resetVendorUser', () => ({
        user: vendorUser('SUPPORT', { id: OTHER, name: 'Ravi Kumar', active: false }),
        setupToken: 'R'.repeat(43),
        setupExpiresAt: '2026-10-05T04:00:00.000Z',
      }));
    const { user } = renderApp({ cp, path: '/staff' });
    await user.click(await screen.findByRole('button', { name: 'Change Ravi Kumar' }));
    const change = await screen.findByRole('dialog', { name: 'Change Ravi Kumar' });
    await user.selectOptions(within(change).getByLabelText('Role'), 'FINANCE');
    await user.type(within(change).getByLabelText(/^Reason/), 'Moved to accounts');
    await user.click(within(change).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Account changed')).toBeVisible();
    expect(cp.callsOf('updateVendorUser')[0]).toMatchObject({
      params: { id: OTHER },
      body: { role: 'FINANCE', reason: 'Moved to accounts' },
    });

    await user.click(screen.getByRole('button', { name: 'Reset sign-in for Ravi Kumar' }));
    const confirm = await screen.findByRole('dialog', { name: 'Reset sign-in for Ravi Kumar?' });
    await user.click(within(confirm).getByRole('button', { name: 'Reset sign-in' }));
    const shown = await screen.findByRole('dialog', { name: 'Setup link for Ravi Kumar' });
    expect(within(shown).getByLabelText('Setup link')).toHaveTextContent('R'.repeat(43));
  });

  it('records the quarterly access review, disabling whoever is unticked', async () => {
    const cp = controlPlane('SUPER_ADMIN')
      .on('listVendorUsers', users)
      .on('recordVendorAccessReview', () => {
        const after = users().users.map((account) =>
          account.id === OTHER ? { ...account, disabled: true } : account,
        );
        return { users: after };
      });
    const { user, container } = renderApp({ cp, path: '/staff' });
    await user.click(await screen.findByRole('button', { name: 'Access review' }));
    const dialog = await screen.findByRole('dialog', { name: 'Quarterly access review' });
    // The reviewer's own account is not on the list: it is always kept.
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(2);
    await user.click(within(dialog).getByRole('checkbox', { name: /Ravi Kumar/ }));
    await user.type(within(dialog).getByLabelText(/^Note/), 'Checked with team leads');
    await expectNoAxeViolations(container);
    await user.click(within(dialog).getByRole('button', { name: 'Record and disable 1 account' }));
    expect(await screen.findByText('Access review recorded; 1 account disabled')).toBeVisible();
    expect(cp.callsOf('recordVendorAccessReview')[0]?.body).toEqual({
      keep: ['0190a1b2-0000-7000-8000-0000000000ac'],
      note: 'Checked with team leads',
    });
  });

  it('reads where an account stands', () => {
    const now = new Date('2026-10-02T04:00:00.000Z');
    expect(accountStatus(vendorUser('SUPPORT'), now)).toBe('ACTIVE');
    expect(accountStatus(vendorUser('SUPPORT', { active: false }), now)).toBe('SETUP');
    expect(
      accountStatus(vendorUser('SUPPORT', { lockedUntil: '2026-10-02T04:10:00.000Z' }), now),
    ).toBe('LOCKED');
    expect(
      accountStatus(vendorUser('SUPPORT', { lockedUntil: '2026-10-02T03:50:00.000Z' }), now),
    ).toBe('ACTIVE');
    expect(accountStatus(vendorUser('SUPPORT', { disabled: true, active: false }), now)).toBe(
      'DISABLED',
    );
    expect(setupLink('abc', 'https://cp.example')).toBe('https://cp.example/setup#abc');
  });
});
