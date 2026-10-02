import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { kilobytes } from '../src/tenants/DiagnosticsCard.js';
import { INSTALLATION_ID } from './fixtures.js';
import { controlPlane, expectNoAxeViolations, renderApp } from './harness.js';

const ID = '0190a1b2-0000-7000-8000-0000000000f7';
const LISTED = {
  id: ID,
  installationId: INSTALLATION_ID,
  receivedAt: '2026-10-02T09:31:00.000Z',
  note: 'Kitchen printer stops at 8',
  sentBy: { name: 'Meena', role: 'MANAGER' },
  sizeBytes: 48_000,
  requestId: null,
};

function diagnosticsPlane(role: Parameters<typeof controlPlane>[0]) {
  return controlPlane(role)
    .on('listVendorDiagnostics', () => ({ bundles: [LISTED] }))
    .on('getVendorDiagnostics', () => ({
      ...LISTED,
      bundle: {
        format: 1,
        generatedAt: '2026-10-02T09:30:00.000Z',
        installationId: INSTALLATION_ID,
        versions: [{ name: 'Server', version: '1.4.0' }],
        platform: {
          os: 'win32',
          release: '10.0.26100',
          arch: 'x64',
          cpus: 4,
          memoryMb: 8_192,
          uptimeSeconds: 100,
          serverUptimeSeconds: 50,
        },
        configuration: { tls: true },
        settings: { 'storage.warnPercent': 75 },
        status: { database: { status: 'up' } },
        devices: [
          {
            type: 'KDS',
            name: 'Kitchen screen',
            status: 'ACTIVE',
            online: true,
            lastSeenAt: null,
            appVersion: '1.4.0',
          },
        ],
        logs: {
          files: [{ name: 'server.out.log', lines: ['Printer KITCHEN-1 out of paper'] }],
          truncated: true,
        },
      },
    }));
}

describe('[UPD-008] [VCP-007] diagnostics in the web app', () => {
  it('lists what a PC sent for every role; only Support may open one', async () => {
    const cp = diagnosticsPlane('READ_ONLY');
    renderApp({ cp, path: `/installations/${INSTALLATION_ID}` });
    expect(await screen.findByText('Kitchen printer stops at 8')).toBeVisible();
    expect(screen.getByText('Meena (MANAGER)')).toBeVisible();
    expect(screen.getByText('47 KB')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Open the diagnostics/ })).toBeNull();
  });

  it('opens a bundle for Support: versions, devices, settings, status and logs', async () => {
    const cp = diagnosticsPlane('SUPPORT');
    const { user, container } = renderApp({ cp, path: `/installations/${INSTALLATION_ID}` });
    await user.click(
      await screen.findByRole('button', { name: 'Open the diagnostics from 02-10-2026 15:01' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Diagnostics from 02-10-2026 15:01' });
    expect(
      within(dialog).getByText('win32 10.0.26100, 4 processors, 8,192 MB memory'),
    ).toBeVisible();
    expect(within(dialog).getByText('Kitchen screen')).toBeVisible();
    expect(
      within(within(dialog).getByRole('region', { name: 'Log: server.out.log' })).getByText(
        'Printer KITCHEN-1 out of paper',
      ),
    ).toBeVisible();
    expect(within(dialog).getByText(/Older log lines were left out/)).toBeVisible();
    expect(cp.callsOf('getVendorDiagnostics')[0]?.params).toEqual({ id: ID });
    await expectNoAxeViolations(container);
  });

  it('shows sizes in kilobytes', () => {
    expect(kilobytes(100)).toBe('1');
    expect(kilobytes(48_000)).toBe('47');
  });
});
