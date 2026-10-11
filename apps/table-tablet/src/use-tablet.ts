import type { KeyValueStore } from '@rp/mobile-core';
import { TabletSession, type TabletSessionSnapshot } from '@rp/mobile-core';
import { useDeviceSession, useSessionState } from '@rp/mobile-shell';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

/**
 * The tablet's table and session, kept current (TAB-003): read when the app starts, when the
 * connection comes back, when the manager binds the tablet to a table, and on its table's events.
 */
export function useTablet(store: KeyValueStore): TabletSessionSnapshot {
  const session = useDeviceSession();
  const { connection, device } = useSessionState();
  const tablet = useMemo(
    () => new TabletSession({ store, api: () => session.api }),
    [session, store],
  );
  useEffect(() => {
    void tablet.restore();
  }, [tablet]);
  useEffect(
    () =>
      session.onEvent((event) => {
        tablet.handleEvent(event);
      }),
    [session, tablet],
  );
  const tableId = device?.tableId ?? null;
  useEffect(() => {
    if (connection === 'online') void tablet.refresh();
  }, [connection, tableId, tablet]);
  return useSyncExternalStore(tablet.subscribe, tablet.getSnapshot);
}
