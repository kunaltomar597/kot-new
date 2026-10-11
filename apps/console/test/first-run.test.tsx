import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onServerPc } from '../src/screens/ThisPcSetup.js';
import { expectNoAxeViolations, renderConsole, server, t } from './harness.js';

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const bootstrap = () => ({
  status: 201,
  body: {
    code: 'ABCD-EFGH',
    expiresAt: '2026-10-02T10:10:00.000Z',
    caSha256: null,
    serverUrls: [],
    qrPayload: 'rp:pair:ABCD-EFGH',
  },
});

describe('[ONB-001] [ONB-004] the first run on the restaurant PC', () => {
  it('creates the restaurant and the Owner, then pairs this PC and asks the Owner to sign in', async () => {
    const fake = server()
      .on('GET', '/api/v1/first-run', () => ({ status: 200, body: { needed: true, pinLength: 4 } }))
      .on('POST', '/api/v1/first-run', () => ({
        status: 201,
        body: {
          restaurantId: '0190a1b2-c3d4-7000-8000-00000000cc01',
          ownerId: '0190a1b2-c3d4-7000-8000-00000000cc02',
        },
      }))
      .on('POST', '/api/v1/devices/pairing-codes/bootstrap', bootstrap);
    const { user, container } = await renderConsole({ fake, pair: false });
    await user.type(
      await screen.findByLabelText(new RegExp(t('firstRun.restaurantName'))),
      'Spice Route',
    );
    await user.type(screen.getByLabelText(t('firstRun.ownerName')), 'Asha Rao');
    await user.type(screen.getByLabelText(new RegExp(`^${t('firstRun.pin')}`)), '4829');
    await user.type(screen.getByLabelText(t('firstRun.repeatPin')), '4828');
    expect(screen.getByText(t('firstRun.pinMismatch'))).toBeVisible();
    const create = screen.getByRole('button', { name: t('firstRun.create') });
    expect(create).toBeDisabled();
    await expectNoAxeViolations(container);
    await user.clear(screen.getByLabelText(t('firstRun.repeatPin')));
    await user.type(screen.getByLabelText(t('firstRun.repeatPin')), '4829');
    await user.click(create);
    expect(await screen.findByRole('heading', { name: t('login.title') })).toBeInTheDocument();
    expect(fake.callsTo('POST', '/api/v1/first-run')[0]?.body).toEqual({
      restaurantName: 'Spice Route',
      ownerName: 'Asha Rao',
      ownerPin: '4829',
    });
    expect(fake.callsTo('POST', '/api/v1/devices/pair')[0]?.body).toMatchObject({
      code: 'ABCD-EFGH',
    });
  });

  it('pairs an already set-up restaurant PC with one button', async () => {
    const fake = server()
      .on('GET', '/api/v1/first-run', () => ({
        status: 200,
        body: { needed: false, pinLength: 4 },
      }))
      .on('POST', '/api/v1/devices/pairing-codes/bootstrap', bootstrap);
    const { user } = await renderConsole({ fake, pair: false });
    await user.click(await screen.findByRole('button', { name: t('firstRun.pair') }));
    expect(await screen.findByRole('heading', { name: t('login.title') })).toBeInTheDocument();
  });

  it('knows the restaurant PC by its own address', () => {
    expect(onServerPc('localhost')).toBe(true);
    expect(onServerPc('127.0.0.1')).toBe(true);
    expect(onServerPc('pos.local')).toBe(false);
    expect(onServerPc('192.168.1.10')).toBe(false);
  });
});
