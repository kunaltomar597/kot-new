import { describe, expect, it, vi } from 'vitest';
import { createDeviceErrorReporting, watchUncaughtErrors } from '../src/error-reporting.js';

function fakeSession(phase: string) {
  const reportClientError = vi.fn(() => Promise.resolve(undefined));
  return {
    reportClientError,
    session: { api: { reportClientError } as never, getSnapshot: () => ({ phase }) },
  };
}

describe('[NFR-O02] a device’s errors', () => {
  it('go to the restaurant’s server, ten a minute at most', () => {
    let now = 0;
    const { session, reportClientError } = fakeSession('paired');
    const report = createDeviceErrorReporting(session, 'waiter-app', '1.4.0', () => now);
    for (let index = 0; index < 11; index += 1) report(new Error('render failed'), 'TableScreen');
    expect(reportClientError).toHaveBeenCalledTimes(10);
    expect(reportClientError.mock.calls[0]).toMatchObject([
      {
        body: {
          component: 'waiter-app',
          message: 'render failed',
          path: 'TableScreen',
          appVersion: '1.4.0',
        },
      },
    ]);
    now = 61_000;
    report('later');
    expect(reportClientError).toHaveBeenCalledTimes(11);
  });

  it('wait for pairing, and chain React Native’s global handler', () => {
    const unpaired = fakeSession('unpaired');
    createDeviceErrorReporting(unpaired.session, 'table-tablet', null)(new Error('x'));
    expect(unpaired.reportClientError).not.toHaveBeenCalled();

    const previous = vi.fn();
    let handler: ((error: unknown, fatal?: boolean) => void) | undefined;
    const errorUtils = {
      getGlobalHandler: () => previous,
      setGlobalHandler: (next: typeof handler) => {
        handler = next;
      },
    };
    vi.stubGlobal('ErrorUtils', errorUtils);
    const report = vi.fn();
    watchUncaughtErrors(report);
    handler?.(new Error('crash'), true);
    expect(report).toHaveBeenCalledOnce();
    expect(previous).toHaveBeenCalledWith(new Error('crash'), true);
    vi.unstubAllGlobals();
  });
});
