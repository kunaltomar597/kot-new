import { describe, expect, it, vi } from 'vitest';
import { createErrorReporting } from '../src/app/error-reporting.js';

function fakeController(phase: 'paired' | 'unpaired') {
  const reportClientError = vi.fn(() => Promise.resolve(undefined));
  return {
    reportClientError,
    controller: {
      getSnapshot: () => ({ phase }) as never,
      api: { reportClientError } as never,
    },
  };
}

describe('[NFR-O02] the console’s errors', () => {
  it('sends them to the local server, at most ten a minute', () => {
    const { controller, reportClientError } = fakeController('paired');
    const report = createErrorReporting(controller, '1.4.0', () => '/pos/tables?x=1');
    const error = new TypeError('Cannot read properties of undefined');
    for (let index = 0; index < 12; index += 1) report(error);
    expect(reportClientError).toHaveBeenCalledTimes(10);
    expect(reportClientError).toHaveBeenCalledWith({
      body: {
        component: 'console',
        message: 'Cannot read properties of undefined',
        stack: error.stack,
        path: '/pos/tables?x=1',
        appVersion: '1.4.0',
      },
    });
  });

  it('stays quiet on a console that is not paired, and never throws', () => {
    const unpaired = fakeController('unpaired');
    createErrorReporting(unpaired.controller, '1.4.0', () => '/')('boom');
    expect(unpaired.reportClientError).not.toHaveBeenCalled();
    const failing = fakeController('paired');
    failing.reportClientError.mockReturnValue(Promise.reject(new Error('offline')));
    expect(() => {
      createErrorReporting(failing.controller, '1.4.0', () => '/')({ odd: true });
    }).not.toThrow();
    expect(failing.reportClientError.mock.calls[0]).toMatchObject([
      { body: { message: 'Unknown error' } },
    ]);
  });
});
