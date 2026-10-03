import { displayDateTime } from '@rp/domain';
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeServer } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { backupsView, systemStatus } from './system-fixture.js';

const PATH = '/manage/system';

function systemServer(...answers: ReturnType<typeof systemStatus>[]): FakeServer {
  const bodies = answers.length === 0 ? [systemStatus()] : answers;
  return signsInAs(server(), 'MANAGER')
    .on('GET', '/api/v1/system', ...bodies.map((body) => () => ({ status: 200, body })))
    .on('POST', '/api/v1/system/update/approve', () => ({
      status: 200,
      body: systemStatus(),
    }))
    .on('GET', '/api/v1/backups', () => ({ status: 200, body: backupsView() }));
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
    expect(await backup.findByText(t('backups.health.OK'))).toBeVisible();
    const versions = await section(t('systemPage.versions.title'));
    expect(versions.getByText('16.4')).toBeVisible();
    await expectNoAxeViolations(container);
  });

  it('[DATA-002] [DATA-005] shows the backups, where they are kept, and backs up now', async () => {
    const running = backupsView({ running: true });
    const done = backupsView({
      lastSuccessAt: '2026-10-02T09:32:00.000Z',
      runs: [
        {
          id: '0190a1b2-c3d4-7000-8000-00000000bb02',
          kind: 'MANUAL',
          status: 'PARTIAL',
          startedAt: '2026-10-02T09:30:00.000Z',
          finishedAt: '2026-10-02T09:32:00.000Z',
          fileName: 'rp-backup-20261002T093000Z-manual.rpbk',
          sizeBytes: 53 * 1_024 ** 2,
          secondCopy: 'FAILED',
          cloud: null,
          error: 'The copy to the second location failed: the drive is not there.',
          requestedBy: 'Test manager',
        },
        ...backupsView().runs,
      ],
      health: 'FAILED',
    });
    const fake = systemServer()
      .on(
        'GET',
        '/api/v1/backups',
        () => ({ status: 200, body: backupsView() }),
        () => ({ status: 200, body: running }),
        () => ({ status: 200, body: done }),
      )
      .on('POST', '/api/v1/backups', () => ({
        status: 202,
        body: { run: { ...done.runs[0], status: 'RUNNING', finishedAt: null, error: null } },
      }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { user, container } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
      const backup = await section(t('systemPage.backup.title'));
      expect(await backup.findByText(t('backups.health.OK'))).toBeVisible();
      expect(backup.getByText(t('backups.kept', { count: 2 }))).toBeVisible();
      expect(backup.getByText(/No second location is set/)).toBeVisible();
      expect(backup.getByRole('link', { name: t('backups.openSettings') })).toHaveAttribute(
        'href',
        '/manage/settings',
      );
      const table = within(backup.getByRole('table', { name: t('backups.latest') }));
      expect(table.getByText(t('backups.status.SUCCEEDED'))).toBeVisible();
      expect(table.getByText(`${t('backups.notCopied')} ${t('backups.inCloud')}`)).toBeVisible();
      // DATA-003: the copy in the cloud.
      expect(backup.getByText(t('backups.cloud.state.OK'))).toBeVisible();
      const at = (iso: string) => t('backups.at', displayDateTime(new Date(iso)));
      expect(
        backup.getByText(
          `${t('backups.cloud.last', {
            when: at('2026-10-01T23:00:00.000Z'),
            sent: at('2026-10-01T23:20:00.000Z'),
          })} ${t('backups.cloud.escrowed', { when: at('2026-10-01T23:30:00.000Z') })}`,
        ),
      ).toBeVisible();
      await expectNoAxeViolations(container);

      await user.click(backup.getByRole('button', { name: t('backups.now') }));
      expect(await screen.findByText(t('backups.started'))).toBeVisible();
      expect(fake.callsTo('POST', '/api/v1/backups')).toHaveLength(1);
      expect(await backup.findByRole('button', { name: t('backups.running') })).toBeDisabled();
      await vi.advanceTimersByTimeAsync(3_100);
      expect(await backup.findByText(t('backups.health.FAILED'))).toBeVisible();
      expect(
        backup.getByText('The copy to the second location failed: the drive is not there.'),
      ).toBeVisible();
      expect(
        backup.getByText(
          t('backups.kindBy', { kind: t('backups.kind.MANUAL'), name: 'Test manager' }),
        ),
      ).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it('[DATA-004] [AUTH-006] lets the Owner restore from a backup and see the recovery key', async () => {
    const fake = signsInAs(server(), 'OWNER')
      .on('GET', '/api/v1/system', () => ({ status: 200, body: systemStatus() }))
      .on('GET', '/api/v1/backups', () => ({ status: 200, body: backupsView() }))
      .on('POST', '/api/v1/backups/restore', () => ({
        status: 202,
        body: {
          requestedAt: '2026-10-02T10:00:00.000Z',
          backupCreatedAt: '2026-09-30T23:00:00.000Z',
          pointInTime: null,
        },
      }))
      .on('POST', '/api/v1/backups/recovery-key', () => ({
        status: 200,
        body: {
          recoveryKey: 'RPK1-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH-IIIII-JJJJJ-KKKKK',
          keyId: '0123456789abcdef',
        },
      }));
    const { user, container } = await renderConsole({ fake, path: PATH, signedIn: 'OWNER' });
    const backup = await section(t('systemPage.backup.title'));
    await user.click(await backup.findByRole('button', { name: t('backups.restore.open') }));
    const dialog = within(await screen.findByRole('dialog', { name: t('backups.restore.title') }));
    await expectNoAxeViolations(container);
    // Newest first; the older one is chosen here.
    const choice = dialog.getByRole('combobox', { name: t('backups.restore.backup') });
    expect(within(choice).getAllByRole('option')).toHaveLength(2);
    await user.selectOptions(choice, 'DATA_DRIVE/rp-backup-20260930T230000Z-nightly.rpbk');
    const when = t('backups.at', displayDateTime(new Date('2026-09-30T23:00:00.000Z')));
    expect(dialog.getByText(t('backups.restore.loss', { when }))).toBeVisible();
    const confirm = dialog.getByRole('button', { name: t('backups.restore.confirm') });
    expect(confirm).toBeDisabled();
    await user.type(
      dialog.getByRole('textbox', { name: t('backups.restore.reason') }),
      'Bad import',
    );
    expect(confirm).toBeDisabled();
    await user.click(dialog.getByRole('checkbox', { name: t('backups.restore.understood') }));
    await user.click(confirm);
    expect(
      await backup.findByText(
        t('backups.restore.restarting', {
          when: t('backups.at', displayDateTime(new Date('2026-09-30T23:00:00.000Z'))),
        }),
      ),
    ).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/backups/restore')[0]?.body).toEqual({
      location: 'DATA_DRIVE',
      fileName: 'rp-backup-20260930T230000Z-nightly.rpbk',
      reason: 'Bad import',
    });
    expect(backup.getByRole('button', { name: t('backups.restore.open') })).toBeDisabled();

    await user.click(backup.getByRole('button', { name: t('backups.recovery.show') }));
    const shown = within(await screen.findByRole('dialog', { name: t('backups.recovery.title') }));
    expect(shown.getByText(/^RPK1-AAAAA-BBBBB/)).toBeVisible();
  });

  it('[DATA-004] restores to the latest moment or a chosen minute from the continuous backup', async () => {
    const continuous = {
      state: 'OK' as const,
      mode: 'CONTINUOUS' as const,
      lastArchivedAt: '2026-10-02T09:55:00.000Z',
      waiting: 0,
      secondLocationBehind: 0,
      lastBaseBackupAt: '2026-10-01T23:10:00.000Z',
      restorableFrom: '2026-10-01T23:10:00.000Z',
      error: null,
    };
    const fake = signsInAs(server(), 'OWNER')
      .on('GET', '/api/v1/system', () => ({ status: 200, body: systemStatus() }))
      .on('GET', '/api/v1/backups', () => ({ status: 200, body: backupsView({ continuous }) }))
      .on('POST', '/api/v1/backups/restore', () => ({
        status: 202,
        body: {
          requestedAt: '2026-10-02T10:00:00.000Z',
          backupCreatedAt: '2026-10-01T23:10:00.000Z',
          pointInTime: '2026-10-02T04:00:00.000Z',
        },
      }));
    const { user, container } = await renderConsole({ fake, path: PATH, signedIn: 'OWNER' });
    const backup = await section(t('systemPage.backup.title'));
    const at = (iso: string) => t('backups.at', displayDateTime(new Date(iso)));
    expect(await backup.findByText(t('backups.continuous.state.OK'))).toBeVisible();
    expect(
      backup.getByText(
        new RegExp(t('backups.continuous.archived', { when: at(continuous.lastArchivedAt) })),
      ),
    ).toBeVisible();

    await user.click(backup.getByRole('button', { name: t('backups.restore.open') }));
    const dialog = within(await screen.findByRole('dialog', { name: t('backups.restore.title') }));
    const choice = dialog.getByRole('combobox', { name: t('backups.restore.backup') });
    // The latest moment first, then a chosen minute, then the nightly backups.
    expect(within(choice).getAllByRole('option')).toHaveLength(4);
    expect(choice).toHaveValue('LATEST');
    expect(
      dialog.getByText(t('backups.restore.lossLatest', { when: at(continuous.lastArchivedAt) })),
    ).toBeVisible();

    await user.selectOptions(choice, 'MOMENT');
    const field = dialog.getByLabelText(t('backups.restore.momentLabel'));
    // Before the oldest base backup: refused.
    fireEvent.change(field, { target: { value: '2026-09-01T10:00' } });
    const from = at(continuous.restorableFrom);
    expect(dialog.getByText(t('backups.restore.momentInvalid', { from }))).toBeVisible();
    await expectNoAxeViolations(container);
    // 09:30 in India is 04:00 UTC.
    fireEvent.change(field, { target: { value: '2026-10-02T09:30' } });
    expect(
      dialog.getByText(t('backups.restore.loss', { when: at('2026-10-02T04:00:00.000Z') })),
    ).toBeVisible();
    await user.type(
      dialog.getByRole('textbox', { name: t('backups.restore.reason') }),
      'Wrong menu import',
    );
    await user.click(dialog.getByRole('checkbox', { name: t('backups.restore.understood') }));
    await user.click(dialog.getByRole('button', { name: t('backups.restore.confirm') }));
    expect(
      await backup.findByText(
        t('backups.restore.restarting', { when: at('2026-10-02T04:00:00.000Z') }),
      ),
    ).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/backups/restore')[0]?.body).toEqual({
      pointInTime: { to: '2026-10-02T04:00:00.000Z' },
      reason: 'Wrong menu import',
    });
  });

  it('[DATA-004] keeps restore away from managers, and shows how the last restore went', async () => {
    const fake = systemServer().on('GET', '/api/v1/backups', () => ({
      status: 200,
      body: backupsView({
        lastRestore: {
          at: '2026-10-02T10:05:00.000Z',
          ok: false,
          error: 'The database is in use. Stop the restaurant server before restoring.',
          backupCreatedAt: null,
          restoredTo: null,
          previousDatabase: null,
        },
        continuous: {
          ...backupsView().continuous,
          state: 'FAILING',
          lastArchivedAt: '2026-10-02T09:55:00.000Z',
          restorableFrom: '2026-10-01T23:10:00.000Z',
          error: 'The base backup failed: disk full',
        },
      }),
    }));
    await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    const backup = await section(t('systemPage.backup.title'));
    expect(
      await backup.findByText(/The restore on .* failed, and nothing was changed/),
    ).toBeVisible();
    // DATA-005: the continuous backup's failure shows too.
    expect(backup.getByText(t('backups.continuous.state.FAILING'))).toBeVisible();
    expect(backup.getByText('The base backup failed: disk full')).toBeVisible();
    expect(backup.queryByRole('button', { name: t('backups.restore.open') })).toBeNull();
    expect(backup.queryByRole('button', { name: t('backups.recovery.show') })).toBeNull();
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
