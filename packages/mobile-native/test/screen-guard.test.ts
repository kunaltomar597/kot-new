import { describe, expect, it } from 'vitest';
import { AndroidScreenGuard } from '../src/index.js';

describe('[SEC-010] [MOBILE-I4] the screen guard on Android', () => {
  it('passes on to the native module whether the window is secure', async () => {
    const calls: boolean[] = [];
    const guard = new AndroidScreenGuard({
      secureScreen: (on) => {
        calls.push(on);
        return Promise.resolve();
      },
    });
    await guard.secure(true);
    await guard.secure(false);
    expect(calls).toEqual([true, false]);
  });
});
