import { useCallback, useEffect, useRef, useState } from 'react';

export type Loaded<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: unknown }
  | { readonly status: 'ready'; readonly value: T };

/**
 * Loads something when the page opens, when `key` changes and on `reload()`. A reload keeps the
 * last value on screen until the new one arrives; an answer for an older key is dropped.
 */
export function useLoad<T>(
  load: (signal: AbortSignal) => Promise<T>,
  key: string,
): { readonly data: Loaded<T>; readonly reload: () => void } {
  const [data, setData] = useState<Loaded<T>>({ status: 'loading' });
  const [round, setRound] = useState(0);
  const latest = useRef(load);
  latest.current = load;
  const shownKey = useRef(key);

  useEffect(() => {
    const controller = new AbortController();
    if (shownKey.current !== key) {
      shownKey.current = key;
      setData({ status: 'loading' });
    }
    latest.current(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setData({ status: 'ready', value });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setData({ status: 'error', error });
      },
    );
    return () => {
      controller.abort();
    };
  }, [key, round]);

  const reload = useCallback(() => {
    setRound((value) => value + 1);
  }, []);
  return { data, reload };
}
