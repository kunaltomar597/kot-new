import type { MenuSnapshot } from '@rp/contracts';
import type { OrderDraft, OutboxEntry } from '@rp/mobile-core';
import { useEffect, useState } from 'react';
import { useDeviceSession } from './context.js';

/**
 * The menu on the device (MENU-013): the stored copy at once, even offline, then every change
 * (a newer menu fetched on reconnect or when one is published, availability changes live,
 * MENU-006). `undefined` while the stored copy is read; `null` when the device has no menu yet.
 */
export function useMenu(): MenuSnapshot | null | undefined {
  const session = useDeviceSession();
  const [menu, setMenu] = useState<MenuSnapshot | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    let changed = false;
    const unsubscribe = session.menu.subscribe((current) => {
      changed = true;
      setMenu(current);
    });
    void session.menu.get().then((stored) => {
      // A change that arrived while reading is newer than what was read.
      if (active && !changed) setMenu(stored);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [session]);
  return menu;
}

/** Orders not yet taken by the server, oldest first, kept live (WTR-012). */
export function useUnsentOrders(): readonly OutboxEntry<OrderDraft>[] {
  const session = useDeviceSession();
  const [entries, setEntries] = useState<readonly OutboxEntry<OrderDraft>[]>([]);
  useEffect(() => {
    let active = true;
    let changed = false;
    const unsubscribe = session.orders.subscribe((current) => {
      changed = true;
      setEntries(current);
    });
    void session.orders.list().then((stored) => {
      if (active && !changed) setEntries(stored);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [session]);
  return entries;
}
