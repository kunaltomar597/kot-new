import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), '.state.json');

/** What global-setup started, for the tests. */
export interface E2eState {
  /** The Control Plane, serving the app and its API: `http://127.0.0.1:<port>`. */
  readonly baseUrl: string;
  /** The first Super Admin's one-time setup token, as the CLI printed it. */
  readonly setupToken: string;
  readonly email: string;
}

export function e2eState(): E2eState {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as E2eState;
}
