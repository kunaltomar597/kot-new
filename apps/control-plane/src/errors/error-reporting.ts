import { readFileSync } from 'node:fs';
import { SentryReporter } from '@rp/error-reporting';
import type { CpConfig } from '../config/cp-config.js';

/** This build's version, from its package.json (dist/errors → the package root). */
function packageVersion(): string {
  try {
    const json = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const version: unknown = (JSON.parse(json) as { version?: unknown }).version;
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The Control Plane's reporter to the error service (NFR-O02), or null without a DSN. */
export const CP_ERROR_REPORTER = Symbol('CP_ERROR_REPORTER');

export function errorReporterFor(config: CpConfig): SentryReporter | null {
  if (config.errorDsn === undefined) return null;
  return new SentryReporter({
    dsn: config.errorDsn,
    component: 'control-plane',
    release: `control-plane@${packageVersion()}`,
    environment: config.env,
  });
}
