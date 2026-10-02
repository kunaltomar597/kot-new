import { describe, expect, it } from 'vitest';
import { buildEvent, parseDsn, SentryReporter, stackFrames } from '../src/index.js';

const DSN = 'https://abc123@o1.ingest.example.com/42';

function recordingFetch(status = 200) {
  const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    sent.push({
      url: input instanceof Request ? input.url : input.toString(),
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return Promise.resolve(new Response(null, { status }));
  };
  return { sent, fetch };
}

describe('[NFR-O02] error reports', () => {
  it('reads a DSN', () => {
    expect(parseDsn(DSN)).toEqual({
      endpoint: 'https://o1.ingest.example.com/api/42/envelope/',
      publicKey: 'abc123',
      projectId: '42',
    });
    expect(parseDsn('https://k@sentry.example.com/errors/7').endpoint).toBe(
      'https://sentry.example.com/errors/api/7/envelope/',
    );
    expect(() => parseDsn('https://sentry.example.com/42')).toThrow(/look like/);
    expect(() => parseDsn('not a url')).toThrow(/not a valid/);
  });

  it('[SEC-015] scrubs secrets, personal data and user folders before sending', async () => {
    const { sent, fetch } = recordingFetch();
    const reporter = new SentryReporter({
      dsn: DSN,
      component: 'server',
      release: 'rp@1.4.0',
      environment: 'production',
      fetch,
    });
    const error = new Error(
      'Login failed for kiran@example.com with token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXBhcnQ',
    );
    error.stack = `Error: x\n    at login (C:\\Users\\Asha\\rp\\server\\dist\\auth.js:10:5)\n    at /home/asha/rp/node_modules/express/index.js:3:1`;
    reporter.report(
      error,
      { password: 'hunter2', phone: '+91 98200 12345', path: '/api/v1/auth' },
      { device: 'POS' },
    );
    await reporter.flush();
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toBe('https://o1.ingest.example.com/api/42/envelope/');
    expect(request?.headers['x-sentry-auth']).toContain('sentry_key=abc123');
    const lines = request?.body.split('\n') ?? [];
    expect(lines).toHaveLength(3);
    const event = JSON.parse(lines[2] ?? '{}') as Record<string, unknown>;
    const text = JSON.stringify(event);
    for (const secret of [
      'kiran@example.com',
      'hunter2',
      '98200 12345',
      'eyJhbGci',
      'Asha',
      'asha',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(event).toMatchObject({
      level: 'error',
      release: 'rp@1.4.0',
      environment: 'production',
      tags: { component: 'server', device: 'POS' },
      extra: { password: '[REDACTED]', phone: '[phone]', path: '/api/v1/auth' },
    });
    expect(reporter.stats).toEqual({ sent: 1, dropped: 0 });
  });

  it('sends the same error once a minute and at most so many an hour', async () => {
    let now = new Date('2026-10-02T10:00:00Z');
    const { sent, fetch } = recordingFetch();
    const reporter = new SentryReporter({
      dsn: DSN,
      component: 'server',
      release: 'r',
      environment: 'test',
      fetch,
      maxPerHour: 3,
      now: () => now,
    });
    reporter.report(new Error('same'));
    reporter.report(new Error('same'));
    now = new Date(now.getTime() + 61_000);
    reporter.report(new Error('same'));
    reporter.report(new Error('other'));
    reporter.report(new Error('third'));
    await reporter.flush();
    expect(sent).toHaveLength(3);
    expect(reporter.stats).toEqual({ sent: 3, dropped: 2 });
    now = new Date(now.getTime() + 3_600_000);
    reporter.report(new Error('third'));
    await reporter.flush();
    expect(sent).toHaveLength(4);
  });

  it('never throws when the service is down or refuses', async () => {
    const reporter = new SentryReporter({
      dsn: DSN,
      component: 'server',
      release: 'r',
      environment: 'test',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    reporter.report('a string thrown');
    await reporter.flush();
    expect(reporter.stats).toEqual({ sent: 0, dropped: 1 });
    const refused = new SentryReporter({
      dsn: DSN,
      component: 'server',
      release: 'r',
      environment: 'test',
      fetch: recordingFetch(429).fetch,
    });
    refused.report({ odd: true });
    await refused.flush();
    expect(refused.stats.dropped).toBe(1);
  });

  it('reads V8 stack frames, oldest first, marking library frames', () => {
    const frames = stackFrames(
      'Error: x\n    at inner (/srv/app/dist/a.js:1:2)\n    at Object.<anonymous> (/srv/app/node_modules/lib/b.js:3:4)\n    at node:internal/process:5:6',
    );
    expect(frames.map((frame) => [frame.function, frame.filename, frame.in_app])).toEqual([
      ['?', 'node:internal/process', false],
      ['Object.<anonymous>', '/srv/app/node_modules/lib/b.js', false],
      ['inner', '/srv/app/dist/a.js', true],
    ]);
    expect(stackFrames(undefined)).toEqual([]);
    const event = buildEvent(
      'plain',
      {},
      { component: 'console', release: 'r', environment: 'e', platform: 'javascript' },
      'id',
      new Date(0),
    );
    expect(event.exception.values[0]).toEqual({ type: 'NonError', value: 'plain' });
  });
});
