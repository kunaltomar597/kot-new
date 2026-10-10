import { createTranslator } from '@rp/i18n';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { alertDetail } from '../src/fleet/alert-text.js';
import {
  deviceTotals,
  filterFleet,
  fleetSummary,
  productVersion,
} from '../src/fleet/fleet-view.js';
import { fleetAlert, fleetPc, INSTALLATION_ID, PENDING_ID } from './fixtures.js';
import { controlPlane, expectNoAxeViolations, renderApp } from './harness.js';

const OFFLINE_PC = fleetPc({
  installationId: '0190a1b2-0000-7000-8000-0000000000e9',
  installationName: 'Bar PC',
  online: false,
  lastSeenAt: '2026-10-02T02:00:00.000Z',
  openAlerts: ['OFFLINE', 'DISK_FULL'],
  disk: { totalBytes: 100, freeBytes: 5, usedPercent: 95 },
  backup: {
    lastSuccessAt: '2026-10-01T20:00:00.000Z',
    lastFailureAt: '2026-10-02T20:00:00.000Z',
    lastError: 'USB drive missing',
    cloud: { enabled: false, lastSuccessAt: null, lastFailureAt: null, lastError: null },
  },
  devices: [{ type: 'KDS', paired: 1, connected: null }],
  errorCount: null,
  auditHead: null,
});

function fleetPlane(role: Parameters<typeof controlPlane>[0]) {
  return controlPlane(role)
    .on('getFleet', () => ({
      installations: [
        fleetPc({
          openAlerts: ['AUDIT_CHAIN_MISMATCH'],
          cloudBackupAt: '2026-10-01T23:00:00.000Z',
          backupKeyEscrowedAt: '2026-09-20T10:00:00.000Z',
        }),
        OFFLINE_PC,
        fleetPc({
          installationId: PENDING_ID,
          installationName: 'Kitchen PC',
          status: 'PENDING',
          online: false,
          lastSeenAt: null,
          auditHead: null,
        }),
      ],
      generatedAt: '2026-10-02T04:00:00.000Z',
    }))
    .on('listFleetAlerts', ({ query }) =>
      query.state === 'ALL'
        ? {
            alerts: [
              fleetAlert(),
              fleetAlert({
                id: '0190a1b2-0000-7000-8000-0000000000d3',
                kind: 'DISK_FULL',
                details: { usedPercent: 93 },
                resolvedAt: '2026-10-01T09:00:00.000Z',
                resolvedBy: 'system:fleet',
              }),
            ],
          }
        : {
            alerts: [
              fleetAlert(),
              fleetAlert({
                id: '0190a1b2-0000-7000-8000-0000000000d2',
                installationId: OFFLINE_PC.installationId,
                installationName: 'Bar PC',
                kind: 'OFFLINE',
                details: { minutes: 45 },
              }),
            ],
          },
    );
}

describe('[VCP-005] [NFR-O03] the fleet page', () => {
  it('shows open alerts first, then every PC’s health; Read-only closes nothing', async () => {
    const { user, container } = renderApp({ cp: fleetPlane('READ_ONLY'), path: '/fleet' });
    expect(await screen.findByText('Entry 3,900 was changed (found by a check)')).toBeVisible();
    expect(screen.getByText('Silent for 45 minutes of opening hours')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Close the audit log alert/ })).toBeNull();
    expect(
      await screen.findByText('1 of 2 active PCs online; 3 open alerts. As of 02-10-2026 09:30.'),
    ).toBeVisible();
    expect(screen.getByText('Changed: look into it')).toBeVisible();
    expect(screen.getAllByText('5 of 6 connected')).toHaveLength(2);
    expect(screen.getByText('1 paired')).toBeVisible();
    expect(screen.getByText('95 %')).toBeVisible();
    expect(screen.getByText('Failed 03-10-2026 01:30')).toBeVisible();
    await expectNoAxeViolations(container);

    await user.selectOptions(screen.getByLabelText('Show'), 'OFFLINE');
    const pcs = screen.getByRole('table', { name: 'PCs' });
    expect(
      within(pcs)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Spice Route: Bar PC']);
  });

  it('[AUD-003] lets Support close an audit log alert with what was found', async () => {
    const cp = fleetPlane('SUPPORT').on('resolveFleetAlert', ({ body }) =>
      fleetAlert({
        resolvedAt: '2026-10-02T04:10:00.000Z',
        resolution: (body as { reason: string }).reason,
      }),
    );
    const { user } = renderApp({ cp, path: '/fleet' });
    await user.click(
      await screen.findByRole('button', { name: 'Close the audit log alert for Main counter PC' }),
    );
    // Offline alerts close by themselves: no button.
    expect(screen.getByText('Open: closes by itself once fixed')).toBeVisible();
    const dialog = await screen.findByRole('dialog', { name: 'Close the audit log alert' });
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Restored from backup on 1 Oct');
    await user.click(within(dialog).getByRole('button', { name: 'Close alert' }));
    expect(await screen.findByText('Alert closed')).toBeVisible();
    expect(cp.callsOf('resolveFleetAlert')[0]).toMatchObject({
      params: { id: '0190a1b2-0000-7000-8000-0000000000d1' },
      body: { reason: 'Restored from backup on 1 Oct' },
    });
    await waitFor(() => {
      expect(cp.callsOf('getFleet').length).toBeGreaterThan(1);
    });
  });

  it('shows a PC’s health, its alerts and the audit log fingerprints it reported', async () => {
    const cp = fleetPlane('READ_ONLY').on('listAuditHeads', () => ({
      heads: [
        {
          sequence: 4_120,
          hash: 'a'.repeat(64),
          firstSeenAt: '2026-10-02T03:55:00.000Z',
          verifiedAt: null,
          superseded: false,
        },
        {
          sequence: 3_900,
          hash: 'b'.repeat(64),
          firstSeenAt: '2026-10-01T03:55:00.000Z',
          verifiedAt: '2026-10-02T03:00:00.000Z',
          superseded: true,
        },
      ],
    }));
    const { container } = renderApp({ cp, path: `/installations/${INSTALLATION_ID}` });
    expect(await screen.findByText('RESTAURANT_PC 1.4.0, postgres 16.4')).toBeVisible();
    expect(screen.getByText('62 % used, 177.0 GB free')).toBeVisible();
    expect(screen.getByText('KDS: 1 of 2 connected, WAITER_PHONE: 4 of 4 connected')).toBeVisible();
    // DATA-003: the newest backup the Control Plane holds for it.
    expect(screen.getByText('Newest made 02-10-2026 04:30 (key in escrow)')).toBeVisible();
    expect(await screen.findByText('Set aside after an alert')).toBeVisible();
    expect(screen.getByText('Data drive 93 % full')).toBeVisible();
    expect(screen.getByText('Closed 01-10-2026 14:30')).toBeVisible();
    expect(cp.callsOf('listFleetAlerts')[0]?.query).toEqual({
      state: 'ALL',
      installationId: INSTALLATION_ID,
    });
    await expectNoAxeViolations(container);
  });
});

describe('[UPD-003] a failed update', () => {
  it('lets Support close the alert of a PC that will not run that version', async () => {
    const failed = fleetAlert({
      kind: 'UPDATE_FAILED',
      details: { version: '1.5.0', outcome: 'SILENT', error: null },
    });
    const cp = controlPlane('SUPPORT')
      .on('listFleetAlerts', () => ({ alerts: [failed] }))
      .on('resolveFleetAlert', ({ body }) => ({
        ...failed,
        resolvedAt: '2026-10-04T05:00:00.000Z',
        resolution: (body as { reason: string }).reason,
      }));
    const { user } = renderApp({ cp, path: '/fleet' });
    expect(await screen.findByText('Silent since it started installing 1.5.0')).toBeVisible();
    await user.click(
      await screen.findByRole('button', { name: 'Close the update alert for Main counter PC' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Close the update alert' });
    await user.type(within(dialog).getByLabelText(/^Reason/), 'PC replaced');
    await user.click(within(dialog).getByRole('button', { name: 'Close alert' }));
    expect(await screen.findByText('Alert closed')).toBeVisible();
    expect(cp.callsOf('resolveFleetAlert')[0]?.body).toEqual({ reason: 'PC replaced' });
  });
});

describe('[SEC-015] [LIC-007] licence tampering', () => {
  it('shows what the PC reported and lets Support close it with a reason', async () => {
    const tampering = fleetAlert({
      kind: 'LICENCE_TAMPERING',
      details: { kinds: ['CLOCK_ROLLBACK', 'REACTIVATION_CODE_NOT_ISSUED'] },
    });
    const cp = controlPlane('SUPPORT')
      .on('listFleetAlerts', () => ({ alerts: [tampering] }))
      .on('resolveFleetAlert', ({ body }) => ({
        ...tampering,
        resolvedAt: '2026-10-10T05:00:00.000Z',
        resolution: (body as { reason: string }).reason,
      }));
    const { user } = renderApp({ cp, path: '/fleet' });
    expect(await screen.findByText('Licence tampering')).toBeVisible();
    expect(
      screen.getByText(
        'Reported: the clock set or held back, again and again, a reactivation code the vendor never issued',
      ),
    ).toBeVisible();
    await user.click(
      await screen.findByRole('button', {
        name: 'Close the licence tampering alert for Main counter PC',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Close the licence tampering alert' });
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Flat clock battery, replaced');
    await user.click(within(dialog).getByRole('button', { name: 'Close alert' }));
    expect(await screen.findByText('Alert closed')).toBeVisible();
    expect(cp.callsOf('resolveFleetAlert')[0]?.body).toEqual({
      reason: 'Flat clock battery, replaced',
    });
  });
});

describe('fleet view helpers', () => {
  const t = createTranslator();

  it('filters, totals and summarises PCs', () => {
    const pcs = [fleetPc(), OFFLINE_PC];
    expect(filterFleet(pcs, 'ALERTS')).toEqual([OFFLINE_PC]);
    expect(filterFleet(pcs, 'OFFLINE')).toEqual([OFFLINE_PC]);
    expect(filterFleet(pcs, 'ALL')).toHaveLength(2);
    expect(deviceTotals(fleetPc())).toEqual({ connected: 5, paired: 6 });
    expect(deviceTotals(OFFLINE_PC)).toEqual({ connected: null, paired: 1 });
    expect(fleetSummary(pcs)).toEqual({ active: 2, online: 1, alerts: 2 });
    expect(productVersion(fleetPc())).toBe('1.4.0');
    expect(productVersion(fleetPc({ components: [] }))).toBeNull();
  });

  it('[AUD-003] says what an alert saw', () => {
    expect(alertDetail(fleetAlert({ details: { reason: 'ROLLED_BACK', sequence: 20 } }), t)).toBe(
      'Entries removed: the log now ends at entry 20',
    );
    expect(alertDetail(fleetAlert({ details: { reason: 'EMPTIED', sequence: 25 } }), t)).toBe(
      'The log was emptied',
    );
    expect(
      alertDetail(fleetAlert({ kind: 'BACKUP_FAILED', details: { error: 'Disk full' } }), t),
    ).toBe('The latest backup failed: Disk full');
    // UPD-003: a failed update (P7-04).
    expect(
      alertDetail(
        fleetAlert({
          kind: 'UPDATE_FAILED',
          details: { version: '1.5.0', outcome: 'ROLLED_BACK', error: 'Health check failed' },
        }),
        t,
      ),
    ).toBe('The update to 1.5.0 failed its health check and was rolled back: Health check failed');
    expect(
      alertDetail(
        fleetAlert({ kind: 'UPDATE_FAILED', details: { version: '1.5.0', outcome: 'SILENT' } }),
        t,
      ),
    ).toBe('Silent since it started installing 1.5.0');
    expect(alertDetail(fleetAlert({ kind: 'BACKUP_FAILED', details: null }), t)).toBe(
      'The latest backup failed',
    );
    // UPD-007: a test build at a restaurant (P8-03b3b).
    expect(
      alertDetail(fleetAlert({ kind: 'UNSIGNED_UPDATES', details: { version: '1.5.0' } }), t),
    ).toBe(
      'Version 1.5.0 is a test build that installs unsigned updates. Reinstall it with a signed release.',
    );
  });
});
