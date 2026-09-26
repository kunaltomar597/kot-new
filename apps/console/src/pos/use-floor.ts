import type { FloorResponse, TableOverviewResponse } from '@rp/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConsole, useConsoleState } from '../app/console-context.js';
import { affectsFloor } from './floor-view.js';

/** Wait this long after an event before reading again, so a burst of events costs one read. */
const REFRESH_DELAY_MS = 250;

export type FloorData =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: unknown }
  | {
      readonly status: 'ready';
      readonly floor: FloorResponse;
      readonly overview: TableOverviewResponse;
    };

/**
 * The floor and the live table overview (TBL-007), read again after table, order and bill events
 * and whenever the connection comes back (events missed while offline are replayed, but the read
 * makes sure the screen matches the server).
 */
export function useFloor(): { data: FloorData; reload: () => void } {
  const controller = useConsole();
  const { connection } = useConsoleState();
  const [data, setData] = useState<FloorData>({ status: 'loading' });
  const generation = useRef(0);

  const reload = useCallback(() => {
    const current = ++generation.current;
    Promise.all([controller.api.getFloor(), controller.api.getTableOverview()]).then(
      ([floor, overview]) => {
        if (current === generation.current) setData({ status: 'ready', floor, overview });
      },
      (error: unknown) => {
        // Keep showing the last good floor; only a first load shows the error.
        if (current === generation.current) {
          setData((previous) =>
            previous.status === 'ready' ? previous : { status: 'error', error },
          );
        }
      },
    );
  }, [controller]);

  useEffect(() => {
    reload();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = controller.onEvent((event) => {
      if (!affectsFloor(event.type)) return;
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
  useEffect(() => {
    if (connection === 'online' && !wasOnline.current) reload();
    wasOnline.current = connection === 'online';
  }, [connection, reload]);

  return { data, reload };
}
