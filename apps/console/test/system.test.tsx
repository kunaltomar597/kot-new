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
