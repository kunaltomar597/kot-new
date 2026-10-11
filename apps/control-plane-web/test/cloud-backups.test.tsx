import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { megabytes } from '../src/tenants/CloudBackupsCard.js';
import { INSTALLATION_ID } from './fixtures.js';
import { controlPlane, expectNoAxeViolations, renderApp } from './harness.js';

const BACKUP = {
  id: '0190a1b2-0000-7000-8000-0000000000c1',
  installationId: INSTALLATION_ID,
  fileName: 'rp-backup-20261001T230000Z-nightly.rpbk',
  backupCreatedAt: '2026-10-01T23:00:00.000Z',
  sizeBytes: 230 * 1_024 ** 2,
  sha256: 'c'.repeat(64),
  keyId: '0123456789abcdef',
  status: 'COMPLETE',
  startedAt: '2026-10-01T23:10:00.000Z',
  completedAt: '2026-10-01T23:20:00.000Z',
} as const;

describe('[DATA-003] [OI-10] a PC’s backups in the cloud', () => {
  it('lets Support issue a restore code with how the Owner was verified, shown once', async () => {
    const cp = controlPlane('SUPPORT')
      .on('listVendorCloudBackups', () => ({ backups: [BACKUP] }))
      .on('issueRestoreCode', () => ({
        code: 'ABCD-EFGH-JKLM-NP23',
        installationId: INSTALLATION_ID,
        expiresAt: '2026-10-03T10:00:00.000Z',
      }));
    const { user, container } = renderApp({ cp, path: `/installations/${INSTALLATION_ID}` });
    const card = within(
      (await screen.findByRole('heading', { name: 'Backups in the cloud' })).closest('section')!,
    );
    expect(await card.findByText('02-10-2026 04:30')).toBeVisible();
    expect(card.getByText('230 MB')).toBeVisible();
    await user.click(card.getByRole('button', { name: 'Issue a restore code' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Issue a restore code' }));
    const issue = dialog.getByRole('button', { name: 'Issue the code' });
    await user.type(dialog.getByLabelText(/^Reason/), 'PC stolen');
    expect(issue).toBeDisabled();
    await user.type(dialog.getByLabelText(/^How the Owner was verified/), 'Video call, ID seen');
    await user.click(issue);
    const shown = within(await screen.findByRole('dialog', { name: 'Restore code' }));
    expect(shown.getByText('ABCD-EFGH-JKLM-NP23')).toBeVisible();
    expect(cp.callsOf('issueRestoreCode')[0]).toMatchObject({
      params: { id: INSTALLATION_ID },
      body: { reason: 'PC stolen', ownerVerification: 'Video call, ID seen' },
    });
    await expectNoAxeViolations(container);
  });

  it('shows Read-only the backups but no way to issue a code', async () => {
    const cp = controlPlane('READ_ONLY').on('listVendorCloudBackups', () => ({
      backups: [BACKUP],
    }));
    renderApp({ cp, path: `/installations/${INSTALLATION_ID}` });
    expect(await screen.findByText('230 MB')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Issue a restore code' })).toBeNull();
  });

  it('shows sizes in megabytes', () => {
    expect(megabytes(1)).toBe('1');
    expect(megabytes(5 * 1_024 ** 2 + 1)).toBe('5');
  });
});
