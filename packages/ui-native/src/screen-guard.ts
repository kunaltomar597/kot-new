import { useEffect } from 'react';

/** What blocks screenshots, screen recording and the recent apps' preview (MOBILE-I4, SEC-010). */
export interface ScreenGuard {
  secure(on: boolean): void | Promise<void>;
}

let guard: ScreenGuard | null = null;
let holds = 0;

/** The app gives the guard once at start; without one (tests, tools) nothing is blocked. */
export function setScreenGuard(next: ScreenGuard | null): void {
  guard = next;
  holds = 0;
}

function apply(on: boolean): void {
  // A device that cannot block capture still works: the PIN pad is not held back by it.
  Promise.resolve(guard?.secure(on)).catch(() => undefined);
}

/** The screen is secure from the first hold to the last release; returns the release. */
export function holdSecureScreen(): () => void {
  holds += 1;
  if (holds === 1) apply(true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
    if (holds === 0) apply(false);
  };
}

/** Keeps the screen secure while the calling component shows. */
export function useSecureScreen(): void {
  useEffect(() => holdSecureScreen(), []);
}
