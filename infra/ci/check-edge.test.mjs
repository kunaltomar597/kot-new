import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { flood, judge, parseArguments } from '../edge/check-edge.mjs';

/** A server that answers `allowed` requests and then 429. */
function serve(allowed, retryAfter) {
  let seen = 0;
  const server = createServer((request, response) => {
    seen += 1;
    if (request.url === '/health') return response.end('ok');
    if (seen > allowed) {
      response.statusCode = 429;
      if (retryAfter) response.setHeader('retry-after', '1');
    }
    response.end('{}');
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1/x` }),
    ),
  );
}

test('[SEC-001] check-edge: reads its options', () => {
  const options = parseArguments(['https://x/y', '--requests', '10', '--header', 'a: b: c']);
  assert.equal(options.requests, 10);
  assert.deepEqual(options.headers, { a: 'b: c' });
  assert.throws(() => parseArguments([]), /address/);
  assert.throws(() => parseArguments(['u', '--nope']), /Unknown/);
});

test('[SEC-001] check-edge: passes when the edge limits, with Retry-After', async () => {
  const { server, url } = await serve(20, true);
  try {
    const options = parseArguments([url, '--requests', '100', '--concurrency', '5']);
    const counts = await flood(options);
    assert.equal(counts.total, 100);
    assert.equal(counts.limited, 80);
    assert.deepEqual(judge(counts, options, 200), []);
  } finally {
    server.close();
  }
});

test('[SEC-001] check-edge: fails with no limit, no Retry-After or a limited probe', async () => {
  const none = await serve(1_000, true);
  const noHeader = await serve(5, false);
  try {
    const a = parseArguments([none.url, '--requests', '50']);
    assert.match(judge(await flood(a), a, undefined)[0], /none was limited/);
    const b = parseArguments([noHeader.url, '--requests', '50']);
    assert.match(judge(await flood(b), b, undefined)[0], /no Retry-After/);
    assert.match(judge({ total: 5, limited: 5, retryAfter: 5 }, b, 429)[0], /health probe/);
  } finally {
    none.server.close();
    noHeader.server.close();
  }
});
