import type { VendorReleaseView } from '@rp/contracts/control-plane';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { installsLabel, percentOf, rolloutLabel } from '../src/releases/release-view.js';
import { releaseRequestOf } from '../src/releases/ReleasesScreen.js';
import { fleetPc, INSTALLATION_ID, installation } from './fixtures.js';
import { createTranslator } from '@rp/i18n';
import { controlPlane, expectNoAxeViolations, renderApp } from './harness.js';

/** Release management in the vendor web app (P7-04b, VCP-006, UPD-002, UPD-003). */

const RELEASE_ID = '0190a1b2-0000-7000-8000-000000000071';
const t = createTranslator();

function releaseView(overrides: Partial<VendorReleaseView> = {}): VendorReleaseView {
  return {
    id: RELEASE_ID,
    component: 'RESTAURANT_PC',
    channel: 'STABLE',
    version: '1.5.0',
    url: 'https://downloads.example/rp-1.5.0.exe',
    sha256: 'a'.repeat(64),
    sizeBytes: 157_286_400,
    notes: null,
    publishedAt: '2026-10-04T05:00:00.000Z',
    securityCritical: false,
    rollout: {
      percent: 10,
      state: 'ACTIVE',
      cohort: [],
      haltReason: null,
      changedAt: '2026-10-04T05:00:00.000Z',
    },
    target: null,
    installs: { attempts: 5, installed: 4, failures: 1, errorSpikes: 0 },
    ...overrides,
  };
}

describe('[UPD-003] [VCP-006] rollouts in the vendor web app', () => {
  it('says how far each release has gone and how installing it went', () => {
    expect(rolloutLabel(releaseView(), t)).toBe('Rolling out to 10 %');
    expect(
      rolloutLabel(
        releaseView({
          rollout: {
            ...releaseView().rollout,
            state: 'PAUSED',
            percent: 30,
            cohort: [{ id: INSTALLATION_ID, name: 'Main counter PC' }],
          },
        }),
        t,
      ),
    ).toBe('Paused at 30 % and 1 pilot PC');
    expect(
      rolloutLabel(releaseView({ target: { id: INSTALLATION_ID, name: 'Main counter PC' } }), t),
    ).toBe('Hotfix for Main counter PC');
    expect(installsLabel(releaseView(), t)).toBe('4 installed, 1 failed');
    expect(
      installsLabel(
        releaseView({ installs: { attempts: 0, installed: 0, failures: 0, errorSpikes: 0 } }),
        t,
      ),
    ).toBe('None yet');
    expect([percentOf('25'), percentOf('101'), percentOf('5.5'), percentOf('')]).toEqual([
      25,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('builds a hotfix for one PC whatever the share, and a channel release with its share', () => {
    const base = {
      channel: 'STABLE' as const,
      version: '1.5.1-hotfix.1',
      url: 'https://downloads.example/x.exe',
      sha256: 'A'.repeat(64),
      sizeBytes: '1024',
      notes: '',
      percent: '10',
      securityCritical: true,
    };
    const hotfix = releaseRequestOf({ ...base, target: INSTALLATION_ID });
    expect(hotfix.success && hotfix.data).toMatchObject({
      rolloutPercent: 100,
      targetInstallationId: INSTALLATION_ID,
      securityCritical: true,
    });
    const staged = releaseRequestOf({ ...base, target: '' });
    expect(staged.success && staged.data).toMatchObject({
      rolloutPercent: 10,
      targetInstallationId: null,
    });
    expect(releaseRequestOf({ ...base, target: '', percent: 'all' }).success).toBe(false);
  });

  it('lets the Super Admin widen a rollout with a pilot PC and a reason', async () => {
    const halted = releaseView({
      rollout: {
        ...releaseView().rollout,
        state: 'HALTED',
        haltReason: 'Halted automatically: 2 failed or rolled back, of 5 PCs that installed it.',
      },
    });
    const cp = controlPlane('SUPER_ADMIN')
      .on('listVendorReleases', () => ({ releases: [halted] }))
      .on('getFleet', () => ({
        installations: [fleetPc(), fleetPc({ installationId: RELEASE_ID, channel: 'PILOT' })],
        generatedAt: '2026-10-04T05:00:00.000Z',
      }))
      .on('updateVendorRollout', ({ body }) => ({
        ...halted,
        rollout: { ...halted.rollout, ...(body as object), cohort: [], haltReason: null },
      }));
    const { user, container } = renderApp({ cp, path: '/releases' });
    expect(await screen.findByText('Halted')).toBeVisible();
    expect(screen.getByText(/2 failed or rolled back/)).toBeVisible();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: 'Change the rollout of 1.5.0' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Rollout of 1.5.0' }));
    const share = dialog.getByLabelText(/^Share of the channel/);
    await user.clear(share);
    await user.type(share, '30');
    await user.selectOptions(dialog.getByLabelText('Rollout'), 'ACTIVE');
    // Only the release's channel's PCs can be in its cohort.
    const pilots = dialog.getAllByRole('checkbox');
    expect(pilots).toHaveLength(1);
    await user.click(dialog.getByRole('checkbox', { name: 'Main counter PC (Spice Route)' }));
    await user.type(dialog.getByRole('textbox', { name: /Reason/ }), 'Fix confirmed on pilots');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(cp.callsOf('updateVendorRollout')[0]).toMatchObject({
        params: { id: RELEASE_ID },
        body: {
          percent: 30,
          state: 'ACTIVE',
          cohort: [INSTALLATION_ID],
          reason: 'Fix confirmed on pilots',
        },
      });
    });
    expect(await screen.findByText('Rollout changed')).toBeVisible();
  });

  it('shows rollouts to everyone who sees releases, but no changes without the right', async () => {
    const cp = controlPlane('SUPPORT').on('listVendorReleases', () => ({
      releases: [releaseView()],
    }));
    renderApp({ cp, path: '/releases' });
    expect(await screen.findByText('Rolling out to 10 %')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Change the rollout/ })).toBeNull();
    expect(cp.callsOf('getFleet')).toHaveLength(0);
  });
});

describe('[UPD-002] holding a PC at a version', () => {
  it('lets the Super Admin hold a PC and let it follow its channel again', async () => {
    const cp = controlPlane('SUPER_ADMIN').on('pinVendorInstallation', ({ body }) =>
      installation({ pinnedVersion: (body as { version: string | null }).version }),
    );
    const { user } = renderApp({ cp, path: `/installations/${INSTALLATION_ID}` });
    const card = within(
      (await screen.findByRole('heading', { level: 2, name: 'Updates' })).closest('section') ??
        document.body,
    );
    expect(card.getByText('Follows the Stable channel.')).toBeVisible();
    await user.click(card.getByRole('button', { name: 'Hold at a version' }));
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Hold Main counter PC at a version' }),
    );
    const version = dialog.getByLabelText(/^Version/);
    expect(version).toHaveValue('1.4.0');
    await user.type(dialog.getByRole('textbox', { name: /Reason/ }), 'New printer driver pending');
    await user.click(dialog.getByRole('button', { name: 'Hold at a version' }));
    await waitFor(() => {
      expect(cp.callsOf('pinVendorInstallation')[0]?.body).toEqual({
        version: '1.4.0',
        reason: 'New printer driver pending',
      });
    });
    expect(await screen.findByText('Held at 1.4.0')).toBeVisible();
  });

  it('hides the hold from staff who do not manage releases', async () => {
    renderApp({ cp: controlPlane('SUPPORT'), path: `/installations/${INSTALLATION_ID}` });
    expect(await screen.findByRole('heading', { level: 2, name: 'Updates' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Hold at a version' })).toBeNull();
  });
});
