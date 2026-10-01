import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), '.state.json');

/** What global-setup started, for the tests. */
export interface E2eState {
  readonly site: string;
  readonly relayUrl: string;
  readonly relayDatabaseUrl: string;
  readonly credential: string;
  readonly tokens: Readonly<Record<string, string>>;
  readonly tableIds: Readonly<Record<string, string>>;
}

export function e2eState(): E2eState {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as E2eState;
}
