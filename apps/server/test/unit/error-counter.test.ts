import { describe, expect, it, vi } from 'vitest';
import { countingReporter, ErrorCounter } from '../../src/observability/error-reporter.js';

describe('[VCP-005] [NFR-O03] the error count for heartbeats', () => {
  it('counts every reported error and still hands it on', () => {
    const counter = new ErrorCounter();
    const inner = { report: vi.fn() };
    const reporter = countingReporter(counter, inner);
    reporter.report(new Error('one'), { path: '/a' });
    reporter.report(new Error('two'), {});
    expect(counter.total).toBe(2);
    expect(inner.report).toHaveBeenCalledTimes(2);
  });
});
