import type { ConsoleController } from './console-controller.js';

/** At most this many reports a minute from this console: a render loop cannot flood the PC. */
const PER_MINUTE = 10;

/**
 * Sends the console's errors to the local server, which reports them to the vendor's error
 * service, scrubbed (NFR-O02, P7-08d). Only a paired console can; anything that fails here is
 * dropped quietly, never reported again.
 */
export function createErrorReporting(
  controller: Pick<ConsoleController, 'api' | 'getSnapshot'>,
  appVersion: string,
  where: () => string = () => globalThis.location.pathname,
): (error: unknown) => void {
  const sent: number[] = [];
  return (error: unknown) => {
    if (controller.getSnapshot().phase !== 'paired') return;
    const now = Date.now();
    while (sent.length > 0 && now - (sent[0] ?? 0) > 60_000) sent.shift();
    if (sent.length >= PER_MINUTE) return;
    sent.push(now);
    const failure =
      error instanceof Error
        ? error
        : new Error(typeof error === 'string' ? error : 'Unknown error');
    controller.api
      .reportClientError({
        body: {
          component: 'console',
          message: failure.message.slice(0, 1_000),
          stack: failure.stack?.slice(0, 8_000) ?? null,
          path: where().slice(0, 200),
          appVersion,
        },
      })
      .catch(() => undefined);
  };
}

/** Reports uncaught errors and rejected promises in the page. */
export function watchPageErrors(report: (error: unknown) => void): void {
  globalThis.addEventListener('error', (event) => {
    report(event.error ?? event.message);
  });
  globalThis.addEventListener('unhandledrejection', (event) => {
    report(event.reason);
  });
}
