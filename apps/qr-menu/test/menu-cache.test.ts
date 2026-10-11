import type { QrMenuResponse } from '@rp/contracts/relay';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetSharedMenus, MENU_SHARE_MS, sharedMenu } from '../src/site/menu-cache';
import { RelayCallError } from '../src/site/relay';

const menu = { version: 1 } as unknown as QrMenuResponse;

describe('[QR-008] the first view shares one read of the relay per table (RELAY-D4)', () => {
  beforeEach(() => {
    forgetSharedMenus();
  });

  it('asks the relay once for visitors who arrive together, and again after a few seconds', async () => {
    const load = vi.fn().mockResolvedValue(menu);
    const first = await Promise.all([
      sharedMenu('https://r', 't1', 0, load),
      sharedMenu('https://r', 't1', 100, load),
      sharedMenu('https://r', 't1', MENU_SHARE_MS - 1, load),
    ]);
    // Only the first visitor's page was made from its own read; the others were shared, so their
    // pages ask the relay for themselves at once.
    expect(first).toEqual([
      { menu, shared: false },
      { menu, shared: true },
      { menu, shared: true },
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await sharedMenu('https://r', 't1', MENU_SHARE_MS, load)).toEqual({
      menu,
      shared: false,
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps tables apart and does not keep a failure', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new RelayCallError(429, 'RATE_LIMITED', 'slow down'))
      .mockResolvedValue(menu);
    await expect(sharedMenu('https://r', 't1', 0, load)).rejects.toBeInstanceOf(RelayCallError);
    await Promise.resolve();
    await sharedMenu('https://r', 't1', 1, load);
    await sharedMenu('https://r', 't2', 1, load);
    expect(load).toHaveBeenCalledTimes(3);
  });
});
