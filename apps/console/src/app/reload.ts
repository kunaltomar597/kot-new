/** How long after one reload for a new console another is not tried by itself. */
export const RELOAD_GUARD_MS = 10 * 60_000;
const RELOADED_AT = 'rp.console.reloadedForUpdate';

export interface ReloadDeps {
  readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined;
  readonly now: () => number;
  readonly reload: () => void;
}

/**
 * The server was updated past this console (UPD-006): load the page again to get the server's own
 * console. At most once in `RELOAD_GUARD_MS`, so a server that keeps refusing never loops the page;
 * the console then says so and offers a button. Returns whether it reloaded.
 */
export function reloadForNewConsole({ storage, now, reload }: ReloadDeps): boolean {
  try {
    const last = Number(storage?.getItem(RELOADED_AT) ?? 0);
    if (storage === undefined || now() - last < RELOAD_GUARD_MS) return false;
    storage.setItem(RELOADED_AT, String(now()));
  } catch {
    // No session storage (private window, blocked): the console offers the button instead.
    return false;
  }
  reload();
  return true;
}
