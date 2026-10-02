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

describe('[UPD-008] asking a restaurant for diagnostics', () => {
  const request = (overrides: Record<string, unknown> = {}) => ({
    id: '0190a1b2-0000-7000-8000-0000000000f8',
    installationId: INSTALLATION_ID,
    requestedBy: 'Asha Rao',
    reason: 'Bills print twice',
    requestedAt: '2026-10-02T09:00:00.000Z',
    expiresAt: '2026-10-09T09:00:00.000Z',
    state: 'PENDING',
    answeredAt: null,
    answeredBy: null,
    bundleId: null,
    ...overrides,
  });

  it('lets Support ask with a reason, and shows how the restaurant answered', async () => {
    const asked: unknown[] = [];
    const cp = controlPlane('SUPPORT')
      .on('listVendorDiagnosticsRequests', () => ({
        requests: [
          ...asked,
          request({
            id: '0190a1b2-0000-7000-8000-0000000000f9',
            reason: 'Printer stops',
            state: 'DECLINED',
            answeredAt: '2026-10-01T10:00:00.000Z',
            answeredBy: { name: 'Meena', role: 'MANAGER' },
          }),
        ],
      }))
      .on('requestVendorDiagnostics', ({ body }) => {
        const created = request({ reason: (body as { reason: string }).reason });
        asked.unshift(created);
        return created;
      });
    const { user, container } = renderApp({ cp, path: `/installations/${INSTALLATION_ID}` });
    const table = await screen.findByRole('table', { name: 'Requests to the restaurant' });
    expect(within(table).getByText('Declined by Meena')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Ask for diagnostics' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Ask the restaurant for diagnostics',
    });
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Bills print twice');
    await user.click(within(dialog).getByRole('button', { name: 'Ask for diagnostics' }));
    expect(
      await screen.findByText('Request sent. The restaurant sees it within 5 minutes.'),
    ).toBeVisible();
    expect(await within(table).findByText('Waiting for the restaurant')).toBeVisible();
    expect(cp.callsOf('requestVendorDiagnostics')[0]).toMatchObject({
      params: { id: INSTALLATION_ID },
      body: { reason: 'Bills print twice' },
    });
    await expectNoAxeViolations(container);
  });

  it('shows Read-only the requests but no way to ask', async () => {
    const cp = controlPlane('READ_ONLY');
    renderApp({ cp, path: `/installations/${INSTALLATION_ID}` });
    expect(await screen.findByText('No requests yet.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Ask for diagnostics' })).toBeNull();
  });
});
