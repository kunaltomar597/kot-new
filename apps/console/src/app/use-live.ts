import { useCallback, useEffect, useRef, useState } from 'react';
import { useConsole, useConsoleState } from './console-context.js';

/** Wait this long after an event before reading again, so a burst of events costs one read. */
const REFRESH_DELAY_MS = 250;

export type LiveData<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: unknown }
  | { readonly status: 'ready'; readonly value: T };

/**
 * Data read from the server and read again after the events that change it, and when the
 * connection comes back after a drop (the first connection needs no read: events since the page
 * loaded are replayed). A failed refresh keeps the last good value; only a first read shows the
 * error.
 */
export function useLive<T>(
  load: () => Promise<T>,
  affects: (eventType: string) => boolean,
): { data: LiveData<T>; reload: () => void } {
  const controller = useConsole();
  const { connection } = useConsoleState();
  const [data, setData] = useState<LiveData<T>>({ status: 'loading' });
  const generation = useRef(0);
  const latest = useRef({ load, affects });
  latest.current = { load, affects };

  const reload = useCallback(() => {
    const current = ++generation.current;
    latest.current.load().then(
      (value) => {
        if (current === generation.current) setData({ status: 'ready', value });
      },
      (error: unknown) => {
        if (current === generation.current) {
          setData((previous) =>
            previous.status === 'ready' ? previous : { status: 'error', error },
          );
        }
      },
    );
  }, []);

  useEffect(() => {
    reload();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = controller.onEvent((event) => {
      if (!latest.current.affects(event.type)) return;
      clearTimeout(timer);
      timer = setTimeout(reload, REFRESH_DELAY_MS);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
      generation.current += 1;
    };
  }, [controller, reload]);

  const wasOnline = useRef(connection === 'online');
  const everOnline = useRef(connection === 'online');
  useEffect(() => {
    if (connection === 'online' && !wasOnline.current && everOnline.current) reload();
    wasOnline.current = connection === 'online';
    if (connection === 'online') everOnline.current = true;
  }, [connection, reload]);

  return { data, reload };
}
