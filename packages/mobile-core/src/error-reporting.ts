import type { TypedApi } from '@rp/api-client';

/** At most this many reports a minute from this device: a render loop cannot flood the PC. */
const PER_MINUTE = 10;

/**
 * Sends a phone's or tablet's errors to the restaurant's server, which reports them to the
 * vendor's error service, scrubbed (NFR-O02, P7-08d): no app carries the service's key. Only a
 * paired device can; whatever fails here is dropped quietly.
 */
export function createDeviceErrorReporting(
  session: { readonly api: TypedApi; getSnapshot(): { readonly phase: string } },
  component: 'waiter-app' | 'table-tablet',
  appVersion: string | null,
  now: () => number = Date.now,
): (error: unknown, where?: string) => void {
  const sent: number[] = [];
  return (error, where) => {
    if (session.getSnapshot().phase !== 'paired') return;
    const time = now();
    while (sent.length > 0 && time - (sent[0] ?? 0) > 60_000) sent.shift();
    if (sent.length >= PER_MINUTE) return;
    sent.push(time);
    const failure =
      error instanceof Error
        ? error
        : new Error(typeof error === 'string' ? error : 'Unknown error');
    session.api
      .reportClientError({
        body: {
          component,
          message: failure.message.slice(0, 1_000),
          stack: failure.stack?.slice(0, 8_000) ?? null,
          path: where?.slice(0, 200) ?? null,
          appVersion,
        },
      })
      .catch(() => undefined);
  };
}

interface ErrorUtilsLike {
  getGlobalHandler(): (error: unknown, isFatal?: boolean) => void;
  setGlobalHandler(handler: (error: unknown, isFatal?: boolean) => void): void;
}

/**
 * Reports every uncaught JavaScript error (React Native's global handler), then lets the previous
 * handler do what it did (the red box in development, the crash in a release build).
 */
export function watchUncaughtErrors(report: (error: unknown) => void): void {
  const utils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  if (utils === undefined) return;
  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error, isFatal) => {
    report(error);
    previous(error, isFatal);
  });
}
