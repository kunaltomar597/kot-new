#!/usr/bin/env node
// Checks a deployment's rate limits (CP-D1, RELAY-D4, P8-03c2b): sends a burst of cheap requests
// to an address and reports whether the edge or the service answered 429 with Retry-After, and
// that the health probe is never limited. Run it against staging after each change to the edge's
// rules, and before the penetration test:
//
//   node infra/edge/check-edge.mjs https://cloud.example.in/v1/enrolments --method POST
//   node infra/edge/check-edge.mjs https://relay.example/functions/v1/qr-menu --header "x-table-token: <token>"
//
// Options: --requests N (default 400), --concurrency N (default 20), --method M, --header "n: v"
// (repeatable), --health URL (a probe that must never answer 429). Exit 0: limited as expected.
import { pathToFileURL } from 'node:url';

export function parseArguments(argv) {
  const options = {
    url: undefined,
    requests: 400,
    concurrency: 20,
    method: 'GET',
    headers: {},
    health: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${argument} needs a value`);
      return argv[i];
    };
    if (argument === '--requests') options.requests = Number(value());
    else if (argument === '--concurrency') options.concurrency = Number(value());
    else if (argument === '--method') options.method = value().toUpperCase();
    else if (argument === '--health') options.health = value();
    else if (argument === '--header') {
      const [name, ...rest] = value().split(':');
      options.headers[name.trim()] = rest.join(':').trim();
    } else if (argument.startsWith('--')) throw new Error(`Unknown option ${argument}`);
    else options.url = argument;
  }
  if (options.url === undefined) throw new Error('Give the address to flood');
  if (!Number.isInteger(options.requests) || options.requests < 1)
    throw new Error('--requests is a number');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1)
    throw new Error('--concurrency is a number');
  return options;
}

/** Sends the burst; counts the answers. */
export async function flood(options, send = fetch) {
  const counts = { total: 0, limited: 0, retryAfter: 0, failed: 0 };
  let next = 0;
  const lane = async () => {
    while (next < options.requests) {
      next += 1;
      try {
        const response = await send(options.url, {
          method: options.method,
          headers: options.headers,
        });
        counts.total += 1;
        if (response.status === 429) {
          counts.limited += 1;
          if (response.headers.get('retry-after') !== null) counts.retryAfter += 1;
        }
        await response.arrayBuffer().catch(() => undefined);
      } catch {
        counts.failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, lane));
  return counts;
}

/** What the burst shows: the problems, none when the limits work. */
export function judge(counts, options, health) {
  const problems = [];
  if (counts.total === 0) problems.push('no request was answered: is the address right?');
  else if (counts.limited === 0) {
    problems.push(`${String(counts.total)} requests were answered and none was limited (429)`);
  } else if (counts.retryAfter < counts.limited) {
    problems.push(
      `${String(counts.limited - counts.retryAfter)} limited answers had no Retry-After`,
    );
  }
  if (health !== undefined && health === 429) problems.push('the health probe was limited');
  return problems;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const counts = await flood(options);
  const health = options.health === undefined ? undefined : (await fetch(options.health)).status;
  console.log(JSON.stringify({ url: options.url, ...counts, health }));
  const problems = judge(counts, options, health);
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  process.exit(problems.length === 0 ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
