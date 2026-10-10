import type { QrMenuResponse } from '@rp/contracts/relay';
import { fetchMenu } from './relay';

/**
 * The first view of a table's menu (RELAY-D4): a table's phones scan the same code together, and
 * a script can load the page as fast as it likes. The server asks the relay once for a table in
 * this many milliseconds and gives that answer to everyone who comes in between, and to those who
 * arrive while it is being asked. The browser asks for itself after that (QR-008), so a menu this
 * old is never what a diner orders from.
 */
export const MENU_SHARE_MS = 5_000;
const MAX_TABLES = 500;

interface Shared {
  readonly at: number;
  readonly answer: Promise<QrMenuResponse>;
}

const shared = new Map<string, Shared>();

export function sharedMenu(
  relayUrl: string,
  token: string,
  now: number = Date.now(),
  load: typeof fetchMenu = fetchMenu,
): Promise<QrMenuResponse> {
  const key = `${relayUrl}\n${token}`;
  const kept = shared.get(key);
  if (kept !== undefined && now - kept.at < MENU_SHARE_MS) return kept.answer;
  if (shared.size >= MAX_TABLES) {
    for (const [name, entry] of shared) if (now - entry.at >= MENU_SHARE_MS) shared.delete(name);
    // Still full: tables that are all in use at once; the oldest goes.
    const oldest = shared.keys().next().value;
    if (shared.size >= MAX_TABLES && oldest !== undefined) shared.delete(oldest);
  }
  const answer = load(relayUrl, token);
  const entry = { at: now, answer };
  shared.set(key, entry);
  // A failure (an unknown table, the relay down, a 429) is not kept for the next visitor.
  answer.catch(() => {
    if (shared.get(key) === entry) shared.delete(key);
  });
  return answer;
}

/** For tests. */
export function forgetSharedMenus(): void {
  shared.clear();
}
