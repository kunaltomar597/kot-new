import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeServer } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { systemStatus } from './system-fixture.js';

const PATH = '/manage/system';

function systemServer(...answers: ReturnType<typeof systemStatus>[]): FakeServer {
  const bodies = answers.length === 0 ? [systemStatus()] : answers;
  return signsInAs(server(), 'MANAGER')
    .on('GET', '/api/v1/system', ...bodies.map((body) => () => ({ status: 200, body })))
    .on('POST', '/api/v1/system/update/approve', () => ({
      status: 200,
      body: systemStatus(),
    }));
}

const section = async (name: string) =>
  within((await screen.findByRole('heading', { level: 3, name })).closest('section')!);

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[MGR-010] [NFR-I03] the System page', () => {
  it('shows the services, the drive by kind of data, devices and versions', async () => {
    const { container, user } = await renderConsole({
      fake: systemServer(),
      path: '/manage',
      signedIn: 'MANAGER',
    });
    await user.click(
      within(screen.getByRole('navigation', { name: t('dashboard.navigation') })).getByRole(
        'link',
        { name: t('dashboard.section.system') },
      ),
    );
    const services = await section(t('systemPage.services.title'));
    expect(services.getByText(t('systemPage.services.databaseUp', { latency: 2 }))).toBeVisible();
    expect(services.getByText(t('systemPage.uptime.days', { days: 2, hours: 3 }))).toBeVisible();
    expect(services.getByText(t('systemPage.services.vendorOff'))).toBeVisible();
    // P5-03a: whether the QR menu online is in step.
    expect(services.getByText(t('systemPage.services.qrRelay'))).toBeVisible();
    expect(services.getByText(/In step, menu version 3/)).toBeVisible();
    expect(services.getByText(/New QR orders arrive instantly/)).toBeVisible();

    const storage = await section(t('systemPage.storage.title'));
    expect(
      storage.getByText(
        t('systemPage.storage.used', {
          percent: 62,
          free: t('systemPage.bytes.GB', { value: '97' }),
          total: t('systemPage.bytes.GB', { value: '256' }),
        }),
      ),
    ).toBeVisible();
    expect(storage.getByRole('meter', { name: t('systemPage.storage.title') })).toHaveAttribute(
      'value',
      '62',
    );
    expect(storage.getByText(t('systemPage.storage.category.PHOTOS'))).toBeVisible();
    expect(storage.getByText(t('systemPage.bytes.MB', { value: '42' }))).toBeVisible();
    expect(storage.getByText(t('systemPage.storage.notMeasured'))).toBeVisible();
    expect(storage.queryByRole('alert')).toBeNull();

    const devices = await section(t('systemPage.devices.title'));
    expect(
      devices.getByText(t('systemPage.devices.line', { connected: 3, paired: 4 })),
    ).toBeVisible();
    const backup = await section(t('systemPage.backup.title'));
    expect(backup.getByText(t('systemPage.backup.notSetUp'))).toBeVisible();
    const versions = await section(t('systemPage.versions.title'));
    expect(versions.getByText('16.4')).toBeVisible();
    await expectNoAxeViolations(container);
  });

  it('[DATA-006] warns when the drive is getting full', async () => {
    const full = systemStatus();
    const { container } = await renderConsole({
      fake: systemServer({
        ...full,
        storage: {
          ...full.storage,
          usedPercent: 93,
          freeBytes: 18 * 1_024 ** 3,
          level: 'CRITICAL',
        },
      }),
      path: PATH,
      signedIn: 'MANAGER',
    });
    const storage = await section(t('systemPage.storage.title'));
    expect(storage.getByRole('alert')).toHaveTextContent(
      t('systemPage.storage.critical', { percent: 90 }),
    );
    expect(storage.getByText(t('systemPage.storage.level.CRITICAL'))).toBeVisible();
    await expectNoAxeViolations(container);
  });
});

describe('[UPD-004] "Install now"', () => {
  it('shows the update on offer and records a manager’s approval with a reason', async () => {
    const approved = systemStatus();
    const fake = systemServer(systemStatus(), {
      ...approved,
      update: {
        ...approved.update,
        installApproval: {
          version: '1.2.0',
          approvedAt: '2026-10-01T09:31:00.000Z',
          approvedBy: 'Vikram',
        },
      },
    });
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    const update = await section(t('systemPage.update.title'));
    expect(update.getByText(t('systemPage.update.offered', { version: '1.2.0' }))).toBeVisible();
    expect(update.getByText(t('systemPage.update.openTables', { count: 2 }))).toBeVisible();
    await user.click(update.getByRole('button', { name: t('systemPage.update.installNow') }));
    const dialog = within(
      await screen.findByRole('dialog', {
        name: t('systemPage.update.confirmTitle', { version: '1.2.0' }),
      }),
    );
    await user.type(dialog.getByRole('textbox'), 'Quiet afternoon');
    await user.click(dialog.getByRole('button', { name: t('systemPage.update.installNow') }));
    expect(
      await screen.findByText(t('systemPage.update.done', { version: '1.2.0' })),
    ).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/system/update/approve')[0]?.body).toEqual({
      version: '1.2.0',
      reason: 'Quiet afternoon',
    });
    expect(
      await screen.findByText(
        t('systemPage.update.approved', { name: 'Vikram', date: '01-10-2026', time: '15:01' }),
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: t('systemPage.update.installNow') })).toBeNull();
  });
});

const BUNDLE = {
  format: 1,
  generatedAt: '2026-10-02T09:30:00.000Z',
  installationId: null,
  versions: [{ name: 'Server', version: '0.1.0' }],
  platform: {
    os: 'win32',
    release: '10.0.26100',
    arch: 'x64',
    cpus: 4,
    memoryMb: 8_192,
    uptimeSeconds: 100,
    serverUptimeSeconds: 50,
  },
  configuration: {},
  settings: {},
  status: {},
  devices: [],
  logs: { files: [], truncated: false },
};

describe('[UPD-008] sending diagnostics to support', () => {
  it('saves what would be sent even before the vendor link exists', async () => {
    const createObjectURL = vi.fn((_file: Blob) => 'blob:diagnostics');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const fake = systemServer().on('GET', '/api/v1/system/diagnostics', () => ({
      status: 200,
      body: BUNDLE,
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    const support = await section(t('systemPage.diagnostics.title'));
    expect(support.getByRole('button', { name: t('systemPage.diagnostics.send') })).toBeDisabled();
    expect(support.getByText(t('systemPage.diagnostics.unavailable'))).toBeVisible();
    await user.click(support.getByRole('button', { name: t('systemPage.diagnostics.preview') }));
    await vi.waitFor(() => {
      expect(createObjectURL).toHaveBeenCalledOnce();
    });
    const file = createObjectURL.mock.calls[0]![0];
    expect(JSON.parse(await file.text())).toMatchObject({ format: 1 });
  });

  it('sends them with a note and gives the reference to quote', async () => {
    const connected = systemStatus({
      controlPlane: {
        configured: true,
        enrolled: true,
        lastContactAt: '2026-10-02T09:29:00.000Z',
        lastError: null,
      },
    });
    const fake = systemServer(connected).on('POST', '/api/v1/system/diagnostics', () => ({
      status: 200,
      body: { id: '0190a1b2-c3d4-7000-8000-000000000001', sentAt: '2026-10-02T09:31:00.000Z' },
    }));
    const { user, container } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    const support = await section(t('systemPage.diagnostics.title'));
    await user.click(support.getByRole('button', { name: t('systemPage.diagnostics.send') }));
    const dialog = await screen.findByRole('dialog', { name: t('systemPage.diagnostics.send') });
    await user.type(
      within(dialog).getByLabelText(new RegExp(t('systemPage.diagnostics.note'))),
      'Kitchen printer stops at 8',
    );
    await expectNoAxeViolations(container);
    await user.click(
      within(dialog).getByRole('button', { name: t('systemPage.diagnostics.confirm') }),
    );
    expect(
      await support.findByText(t('systemPage.diagnostics.sent', { reference: '0190A1B2' })),
    ).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/system/diagnostics')[0]?.body).toEqual({
      note: 'Kitchen printer stops at 8',
    });
  });
});

describe('[UPD-008] support asks for diagnostics', () => {
  const connected = systemStatus({
    controlPlane: {
      configured: true,
      enrolled: true,
      lastContactAt: '2026-10-02T09:29:00.000Z',
      lastError: null,
    },
  });
  const ask = (id: string, reason: string) => ({
    id,
    requestedBy: 'Asha',
    reason,
    requestedAt: '2026-10-02T09:00:00.000Z',
    expiresAt: '2026-10-09T09:00:00.000Z',
  });
  const FIRST = '0190a1b2-c3d4-7000-8000-0000000000a1';
  const SECOND = '0190a1b2-c3d4-7000-8000-0000000000a2';

  it('lets a manager allow one request and decline another', async () => {
    const fake = systemServer(connected, connected, connected)
      .on(
        'GET',
        '/api/v1/system/diagnostics/requests',
        () => ({
          status: 200,
          body: { requests: [ask(FIRST, 'Bills print twice'), ask(SECOND, 'Just checking')] },
        }),
        () => ({ status: 200, body: { requests: [ask(SECOND, 'Just checking')] } }),
        () => ({ status: 200, body: { requests: [] } }),
      )
      .on('POST', `/api/v1/system/diagnostics/requests/${FIRST}/allow`, () => ({
        status: 200,
        body: { id: '0190a1b2-c3d4-7000-8000-0000000000b9', sentAt: '2026-10-02T09:31:00.000Z' },
      }))
      .on('POST', `/api/v1/system/diagnostics/requests/${SECOND}/decline`, () => ({
        status: 204,
        body: undefined,
      }));
    const { user, container } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    const list = await screen.findByRole('list', { name: t('systemPage.diagnostics.requests') });
    expect(
      within(list).getByText(
        t('systemPage.diagnostics.request', {
          name: 'Asha',
          reason: 'Bills print twice',
          until: '09-10-2026',
        }),
      ),
    ).toBeVisible();
    await expectNoAxeViolations(container);
    const [allow] = within(list).getAllByRole('button', {
      name: t('systemPage.diagnostics.allow'),
    });
    await user.click(allow!);
    expect(
      await screen.findByText(t('systemPage.diagnostics.sent', { reference: '0190A1B2' }), {
        selector: '[role="status"]',
      }),
    ).toBeVisible();
    await vi.waitFor(() => {
      expect(within(list).queryByText(/Bills print twice/)).toBeNull();
    });
    await user.click(
      within(list).getByRole('button', { name: t('systemPage.diagnostics.decline') }),
    );
    expect(await screen.findByText(t('systemPage.diagnostics.declined'))).toBeVisible();
    await vi.waitFor(() => {
      expect(screen.queryByRole('list', { name: t('systemPage.diagnostics.requests') })).toBeNull();
    });
    expect(
      fake.callsTo('POST', `/api/v1/system/diagnostics/requests/${SECOND}/decline`),
    ).toHaveLength(1);
  });
});
