import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ProbeResult } from './health-watch.js';

export interface HealthProbeOptions {
  readonly port: number;
  /** Over TLS, trusting only the installation's CA (ADR-0011). */
  readonly caFile?: string;
  readonly timeoutMs?: number;
}

/**
 * Asks the server on this PC for `GET /api/v1/health`: 200 is ok, any other answer is degraded
 * (503: its database is down), no answer in time is unanswered.
 */
export async function probeHealth(options: HealthProbeOptions): Promise<ProbeResult> {
  let ca: Buffer | undefined;
  if (options.caFile !== undefined) {
    try {
      ca = await readFile(options.caFile);
    } catch {
      // No CA yet: the server makes it before it listens, so it is not up either.
      return 'unanswered';
    }
  }
  const timeoutMs = options.timeoutMs ?? 3_000;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const target = {
      host: '127.0.0.1',
      port: options.port,
      path: '/api/v1/health',
      method: 'GET',
      agent: false as const,
      headers: { accept: 'application/json' },
    };
    const request =
      ca === undefined
        ? httpRequest(target)
        : httpsRequest({ ...target, ca, servername: 'localhost' });
    const timer = setTimeout(() => {
      settle('unanswered');
      request.destroy();
    }, timeoutMs);
    request.on('response', (response) => {
      response.resume();
      settle(response.statusCode === 200 ? 'ok' : 'degraded');
    });
    request.on('error', () => {
      settle('unanswered');
    });
    request.end();
  });
}
