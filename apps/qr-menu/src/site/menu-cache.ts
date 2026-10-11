import type { QrMenuResponse } from '@rp/contracts/relay';
import { fetchMenu } from './relay';

/**
 * The first view of a table's menu (RELAY-D4): a table's phones scan the same code together, and
 * a script can load the page as fast as it likes. The server asks the relay once for a table in
 * this many milliseconds and gives that answer to everyone who comes in between, and to those who
 * arrive while it is being asked. A page made from a shared answer asks the relay for itself at
 * once (QR-008), so a restaurant that has just come back is not shown as away; and every page asks
 * again every few seconds, so a menu this old is never what a diner orders from.
 */
export const MENU_SHARE_MS = 5_000;
const MAX_TABLES = 500;

interface Shared {
  readonly at: number;
  readonly answer: Promise<QrMenuResponse>;
}

const shared = new Map<string, Shared>();

/** The relay's answer, and whether it was asked for an earlier visitor (it may be seconds old). */
export interface SharedMenu {
  readonly menu: QrMenuResponse;
  readonly shared: boolean;
}

export function sharedMenu(
  relayUrl: string,
  token: string,
  now: number = Date.now(),
  load: typeof fetchMenu = fetchMenu,
): Promise<SharedMenu> {
  const key = `${relayUrl}\n${token}`;
  const kept = shared.get(key);
  if (kept !== undefined && now - kept.at < MENU_SHARE_MS) {
    return kept.answer.then((menu) => ({ menu, shared: true }));
  }
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
  return answer.then((menu) => ({ menu, shared: false }));
}

/** For tests. */
export function forgetSharedMenus(): void {
  shared.clear();
}
