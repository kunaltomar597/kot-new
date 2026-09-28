import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCATE_REPEAT_MS, LOCATE_SHOW_MS } from '../src/screens/LocateOverlay.js';
import { locateRequested } from './devices-fixture.js';
import { DEVICE_ID } from './fakes.js';
import { renderConsole, server, t } from './harness.js';

/** Records the notes played (Web Audio is not in jsdom). */
class FakeAudioContext {
  static played: number[] = [];
  currentTime = 0;
  destination = {};
  resume() {
    return Promise.resolve();
  }
  createOscillator() {
    const oscillator = {
      type: 'sine',
      frequency: { value: 0 },
      connect: (node: unknown) => node,
      start: () => {
        FakeAudioContext.played.push(oscillator.frequency.value);
      },
      stop: () => undefined,
    };
    return oscillator;
  }
  createGain() {
    return {
      gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined },
      connect: (node: unknown) => node,
    };
  }
}

const OTHER_DEVICE = '0199a0e0-0000-7000-8000-000000000912';

beforeEach(() => {
  FakeAudioContext.played = [];
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('[MGR-006] a manager locates this console', () => {
  it('shows its name and chimes on any screen, once the page has been touched', async () => {
    // On the sign-in screen: nobody needs to be signed in to be found.
    const { user, sockets } = await renderConsole({ fake: server(), path: '/login' });
    await screen.findByRole('heading', { level: 1 });
    // Browsers play sound only after a touch on the page.
    await user.click(document.body);
    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', locateRequested(1, DEVICE_ID, 'Counter POS'));
    });
    const dialog = await screen.findByRole('dialog', {
      name: t('locate.title', { name: 'Counter POS' }),
    });
    expect(within(dialog).getByText(t('locate.description'))).toBeVisible();
    expect(FakeAudioContext.played).toEqual([660, 880, 1175]);
    await user.click(within(dialog).getByRole('button', { name: t('locate.dismiss') }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('chimes again every few seconds and hides by itself', async () => {
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    });
    const { user, sockets } = await renderConsole({ fake: server(), path: '/login' });
    await screen.findByRole('heading', { level: 1 });
    await user.click(document.body);
    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', locateRequested(1, DEVICE_ID, 'Counter POS'));
    });
    await screen.findByRole('dialog', { name: t('locate.title', { name: 'Counter POS' }) });
    await act(() => vi.advanceTimersByTimeAsync(LOCATE_REPEAT_MS));
    expect(FakeAudioContext.played).toHaveLength(6);
    await act(() => vi.advanceTimersByTimeAsync(LOCATE_SHOW_MS));
    expect(screen.queryByRole('dialog')).toBeNull();
    const heard = FakeAudioContext.played.length;
    await act(() => vi.advanceTimersByTimeAsync(LOCATE_REPEAT_MS * 2));
    expect(FakeAudioContext.played).toHaveLength(heard);
  });

  it('ignores a request meant for another device', async () => {
    const { sockets } = await renderConsole({ fake: server(), path: '/login' });
    await screen.findByRole('heading', { level: 1 });
    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', locateRequested(1, OTHER_DEVICE, 'Tandoor screen'));
    });
    // The event is handled synchronously: nothing is shown for it.
    await act(() => Promise.resolve());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(FakeAudioContext.played).toEqual([]);
  });
});
