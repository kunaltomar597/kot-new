import { liveRefresh } from '@rp/ordering';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDeviceSession, useSessionState } from './context.js';

export type LiveData<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: unknown }
  | { readonly status: 'ready'; readonly value: T };

/**
 * Data read from the server and read again after the events that change it, and when the
 * connection comes back after a drop, as in the console. A failed refresh keeps the last good
 * value; only a first read shows the error.
 */
export function useLive<T>(
  load: () => Promise<T>,
  affects: (eventType: string) => boolean,
): { data: LiveData<T>; reload: () => void } {
  const session = useDeviceSession();
  const { connection } = useSessionState();
  const [data, setData] = useState<LiveData<T>>({ status: 'loading' });
  const generation = useRef(0);
  const latest = useRef({ load, affects });
  useEffect(() => {
    latest.current = { load, affects };
  });

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
    // 250 ms after the first event of a burst, whatever follows it (NFR-P01).
    const refresh = liveRefresh(reload);
    const unsubscribe = session.onEvent((event) => {
      if (latest.current.affects(event.type)) refresh.notify();
    });
    return () => {
      refresh.cancel();
      unsubscribe();
      generation.current += 1;
    };
  }, [session, reload]);

  const wasOnline = useRef(connection === 'online');
  const everOnline = useRef(connection === 'online');
  useEffect(() => {
    if (connection === 'online' && !wasOnline.current && everOnline.current) reload();
    wasOnline.current = connection === 'online';
    if (connection === 'online') everOnline.current = true;
  }, [connection, reload]);

  return { data, reload };
}
