/** How long a live screen waits after an event before reading again. */
export const LIVE_REFRESH_DELAY_MS = 250;

/** When a live screen reads its data again. */
export interface LiveRefresh {
  /** An event that changes what the screen shows arrived. */
  notify(): void;
  /** The screen is gone: no read is pending any more. */
  cancel(): void;
}

/**
 * Reads `delayMs` after the first event of a burst, and the events that arrive meanwhile join
 * that read, so a burst of events costs one read (P8-01a, NFR-P01). A steady stream of events,
 * a busy kitchen's, still refreshes the screen every `delayMs`. Waiting again after each event,
 * as the screens did before, kept a new ticket off a kitchen screen for as long as its events
 * kept coming: up to a second in the load test.
 */
export function liveRefresh(
  read: () => void,
  delayMs: number = LIVE_REFRESH_DELAY_MS,
): LiveRefresh {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    notify() {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        read();
      }, delayMs);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
