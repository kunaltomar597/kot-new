import type { AuditEntryView, AuditListResponse } from '@rp/contracts';
import { businessDateOf } from '@rp/domain';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readable, recorded, shortId } from '../src/manage/audit/audit-view.js';
import type { FakeServer } from './fake-server.js';
import { DEVICE_ID, STAFF } from './fakes.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { profileView } from './restaurant-fixture.js';

const TODAY = businessDateOf(new Date(), { cutoff: '04:00', timeZone: 'Asia/Kolkata' });
const SETTING = '0199a0e0-0000-7000-8000-0000000000f7';

function entry(seq: number, overrides: Partial<AuditEntryView> = {}): AuditEntryView {
  return {
    id: `0199a0e0-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    seq,
    at: '2026-10-01T08:30:00.000Z',
    businessDate: TODAY,
    action: 'SETTING_CHANGED',
    entityType: 'setting',
    entityId: SETTING,
    actor: { id: STAFF.MANAGER.staffId, name: STAFF.MANAGER.displayName },
    approver: null,
    device: { id: DEVICE_ID, name: 'Counter POS', type: 'POS' },
    reason: 'Busy grill',
    before: { value: 10 },
    after: { value: 12 },
    ...overrides,
  };
}

function page(query: URLSearchParams): AuditListResponse {
  const offset = Number(query.get('offset') ?? 0);
  const action = query.get('action');
  const all = [
    entry(130),
    entry(129, {
      action: 'INVOICE_VOIDED',
      entityType: 'invoice',
      actor: { id: STAFF.CASHIER.staffId, name: STAFF.CASHIER.displayName },
      approver: { id: STAFF.MANAGER.staffId, name: STAFF.MANAGER.displayName },
      reason: 'Wrong table',
      before: { status: 'ISSUED' },
      after: { status: 'VOIDED' },
    }),
    ...Array.from({ length: 128 }, (_, index) =>
      entry(128 - index, { action: 'LOGIN', reason: null, before: null, after: {} }),
    ),
  ].filter((candidate) => action === null || candidate.action === action);
  const entries = all.slice(offset, offset + 100);
  return {
    from: query.get('from') ?? TODAY,
    to: query.get('to') ?? TODAY,
    total: all.length,
    offset,
    nextOffset: offset + entries.length < all.length ? offset + entries.length : null,
    entries,
    actions: ['INVOICE_VOIDED', 'LOGIN', 'SETTING_CHANGED'],
    people: [
      { id: STAFF.CASHIER.staffId, name: STAFF.CASHIER.displayName },
      { id: STAFF.MANAGER.staffId, name: STAFF.MANAGER.displayName },
    ],
  };
}

function auditServer(): FakeServer {
  return signsInAs(server(), 'MANAGER')
    .on('GET', '/api/v1/restaurant', () => ({ status: 200, body: profileView() }))
    .on('GET', '/api/v1/audit', (call) => ({
      status: 200,
      body: page(new URL(`http://x${call.path}`).searchParams),
    }))
    .on(
      'GET',
      '/api/v1/audit/verify',
      () => ({
        status: 200,
        body: {
          valid: true,
          checkedEntries: 130,
          head: { seq: 130, hash: 'ab'.repeat(32) },
          verifiedAt: '2026-10-01T10:00:00.000Z',
        },
      }),
      () => ({
        status: 200,
        body: {
          valid: false,
          checkedEntries: 57,
          head: { seq: 130, hash: 'ab'.repeat(32) },
          firstBreak: { seq: 57, entryId: SETTING, reason: 'HASH_MISMATCH' },
          verifiedAt: '2026-10-01T10:05:00.000Z',
        },
      }),
    );
}

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[AUD-005] the audit trail', () => {
  it('lists who did what, approved by whom, where and why, with the changes', async () => {
    const { user, container } = await renderConsole({
      fake: auditServer(),
      path: '/manage',
      signedIn: 'MANAGER',
    });
    await user.click(
      within(screen.getByRole('navigation', { name: t('dashboard.navigation') })).getByRole(
        'link',
        { name: t('dashboard.section.audit') },
      ),
    );
    const table = within(await screen.findByRole('table', { name: t('auditPage.table') }));
    const voided = table.getByText('Invoice voided').closest('tr') as HTMLElement;
    expect(within(voided).getByText(STAFF.CASHIER.displayName)).toBeVisible();
    expect(within(voided).getByText(STAFF.MANAGER.displayName)).toBeVisible();
    expect(within(voided).getByText('Wrong table')).toBeVisible();
    expect(within(voided).getByText('Counter POS')).toBeVisible();
    await user.click(within(voided).getByText(t('auditPage.changes')));
    expect(within(voided).getByText(/"status": "VOIDED"/)).toBeVisible();
    expect(screen.getByText('130')).toBeVisible();
    await expectNoAxeViolations(container);
  });

  it('filters by action, kept in the address, and reads more a page at a time', async () => {
    const fake = auditServer();
    const { user } = await renderConsole({ fake, path: '/manage/audit', signedIn: 'MANAGER' });
    const table = await screen.findByRole('table', { name: t('auditPage.table') });
    expect(within(table).getAllByRole('row')).toHaveLength(101);
    await user.click(screen.getByRole('button', { name: t('auditPage.more') }));
    await waitFor(() => {
      expect(within(table).getAllByRole('row')).toHaveLength(131);
    });
    await user.selectOptions(
      screen.getByRole('combobox', { name: t('auditPage.action') }),
      'Setting changed',
    );
    await waitFor(() => {
      expect(fake.calls.some((call) => call.path.includes('action=SETTING_CHANGED'))).toBe(true);
    });
    const filtered = await screen.findByRole('table', { name: t('auditPage.table') });
    await waitFor(() => {
      expect(within(filtered).getAllByRole('row')).toHaveLength(2);
    });
  });

  it('[AUD-003] checks the chain and says where it broke', async () => {
    const { user } = await renderConsole({
      fake: auditServer(),
      path: '/manage/audit',
      signedIn: 'MANAGER',
    });
    await user.click(await screen.findByRole('button', { name: t('auditPage.verify.run') }));
    expect(await screen.findByText(t('auditPage.verify.intact'))).toBeVisible();
    await user.click(screen.getByRole('button', { name: t('auditPage.verify.run') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      t('auditPage.verify.broken', {
        seq: 57,
        reason: t('auditPage.verify.reason.HASH_MISMATCH'),
      }),
    );
  });
});

describe('[AUD-005] the audit trail as shown', () => {
  it('makes recorded codes readable and shows what was stored', () => {
    expect(readable('INVOICE_VOIDED')).toBe('Invoice voided');
    expect(readable('order_item')).toBe('Order item');
    expect(recorded(null)).toBeUndefined();
    expect(recorded({})).toBeUndefined();
    expect(recorded({ value: 12 })).toBe('{\n  "value": 12\n}');
    expect(shortId('0199a0e0-0000-7000-8000-000000000001')).toBe('0199a0e0');
  });
});
