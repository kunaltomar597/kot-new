import type { OnboardingResponse } from '@rp/contracts';
import { ONBOARDING_STEPS } from '@rp/domain';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { nextStep, setupCounts } from '../src/manage/setup/setup-view.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';

function onboarding(overrides: Partial<OnboardingResponse> & { done?: readonly string[] } = {}) {
  const done = new Set(overrides.done ?? ['PROFILE', 'TAX', 'FLOOR', 'STAFF']);
  const view: OnboardingResponse = {
    steps: ONBOARDING_STEPS.map((step) => ({
      step,
      status: done.has(step) ? 'DONE' : 'TODO',
      ready: done.has(step) || step === 'INVOICE',
      confirmable: step === 'INVOICE' || step === 'GO_LIVE',
      skippable: step === 'DEVICES' || step === 'QR',
    })),
    complete: false,
    activation: { configured: true, activated: false, installationName: null },
    ...overrides,
  };
  return view;
}

const steps = () => screen.findByRole('list', { name: t('setupPage.steps') });
const row = async (title: string) =>
  within(
    (await within(await steps()).findByRole('heading', { name: new RegExp(title) })).closest('li')!,
  );

describe('[ONB-004] the setup page', () => {
  it('shows the 11 steps with what is left, links each to its page, and resumes', async () => {
    const fake = signsInAs(server(), 'MANAGER')
      .on('GET', '/api/v1/onboarding', () => ({ status: 200, body: onboarding() }))
      .on('PUT', '/api/v1/onboarding/steps/INVOICE', () => ({
        status: 200,
        body: onboarding({ done: ['PROFILE', 'TAX', 'FLOOR', 'STAFF', 'INVOICE'] }),
      }))
      .on('PUT', '/api/v1/onboarding/steps/QR', () => ({ status: 200, body: onboarding() }));
    const { user, container } = await renderConsole({
      fake,
      path: '/manage/setup',
      signedIn: 'MANAGER',
    });
    expect(
      await screen.findByText(t('setupPage.progress', { finished: 4, total: 11 })),
    ).toBeVisible();
    expect(within(await steps()).getAllByRole('listitem')).toHaveLength(11);
    // A manager cannot activate: the Owner does.
    expect(screen.getByText(t('setupPage.activation.ownerOnly'))).toBeVisible();
    await expectNoAxeViolations(container);

    const floor = await row(t('setupPage.step.FLOOR.title'));
    expect(floor.getByText(t('setupPage.status.DONE'))).toBeVisible();
    expect(floor.getByRole('link', { name: t('setupPage.step.FLOOR.open') })).toHaveAttribute(
      'href',
      '/manage/floor',
    );

    const invoice = await row(t('setupPage.step.INVOICE.title'));
    await user.click(invoice.getByRole('button', { name: t('setupPage.step.INVOICE.confirm') }));
    expect(fake.callsTo('PUT', '/api/v1/onboarding/steps/INVOICE')[0]?.body).toEqual({
      status: 'DONE',
    });
    const qr = await row(t('setupPage.step.QR.title'));
    await user.click(qr.getByRole('button', { name: t('setupPage.skip') }));
    expect(fake.callsTo('PUT', '/api/v1/onboarding/steps/QR')[0]?.body).toEqual({
      status: 'SKIPPED',
    });
    // The go-live test waits for every other step: nothing to confirm yet.
    const goLive = await row(t('setupPage.step.GO_LIVE.title'));
    expect(goLive.queryByRole('button', { name: t('setupPage.step.GO_LIVE.confirm') })).toBeNull();
  });

  it('[ONB-003] lets the Owner activate the PC with the vendor’s code', async () => {
    const fake = signsInAs(server(), 'OWNER')
      .on(
        'GET',
        '/api/v1/onboarding',
        () => ({ status: 200, body: onboarding() }),
        () => ({
          status: 200,
          body: onboarding({
            activation: { configured: true, activated: true, installationName: 'Main counter PC' },
          }),
        }),
      )
      .on('POST', '/api/v1/activation', () => ({
        status: 200,
        body: {
          installationId: '0190a1b2-c3d4-7000-8000-00000000ab01',
          installationName: 'Main counter PC',
        },
      }));
    const { user } = await renderConsole({ fake, path: '/manage/setup', signedIn: 'OWNER' });
    const field = await screen.findByLabelText(new RegExp(t('setupPage.activation.code')));
    await user.type(field, 'abcd efgh jklm np23');
    await user.click(screen.getByRole('button', { name: t('setupPage.activation.activate') }));
    expect(
      await screen.findByText(t('setupPage.activation.done', { name: 'Main counter PC' }), {
        selector: '.console-notice',
      }),
    ).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/activation')[0]?.body).toEqual({
      code: 'abcd efgh jklm np23',
    });
  });

  it('shows the progress on the Overview until the setup is done', async () => {
    const fake = signsInAs(server(), 'MANAGER').on('GET', '/api/v1/onboarding', () => ({
      status: 200,
      body: onboarding(),
    }));
    await renderConsole({ fake, path: '/manage', signedIn: 'MANAGER' });
    expect(
      await screen.findByText(t('setupPage.banner', { finished: 4, total: 11 })),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: t('setupPage.continue') })).toHaveAttribute(
      'href',
      '/manage/setup',
    );
  });

  it('counts the steps and finds the next one', () => {
    const view = onboarding();
    expect(setupCounts(view)).toEqual({ finished: 4, total: 11 });
    expect(nextStep(view)).toBe('INVOICE');
    expect(nextStep(onboarding({ done: [...ONBOARDING_STEPS] }))).toBeNull();
  });
});
