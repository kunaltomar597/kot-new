import { uuidV4 } from '@rp/api-client';
import { type KeyValueStore, readJson, TABLET_GUEST_KEYS } from '@rp/mobile-core';
import {
  addLine,
  type CartLine,
  markRejected,
  type NewCartLine,
  removeLine,
  updateLine,
} from '@rp/ordering';
import { useCallback, useEffect, useState } from 'react';

/** Where the diners' cart is kept, wiped with the rest of their data when the table closes. */
export const CART_KEY = TABLET_GUEST_KEYS[0];

function parseCart(value: unknown): CartLine[] {
  if (!Array.isArray(value)) throw new TypeError('Not a cart');
  return value.filter(
    (line): line is CartLine =>
      typeof line === 'object' &&
      line !== null &&
      typeof (line as CartLine).clientLineId === 'string' &&
      typeof (line as CartLine).itemId === 'string' &&
      typeof (line as CartLine).quantity === 'number',
  );
}

export interface Cart {
  readonly lines: readonly CartLine[];
  add(line: NewCartLine): void;
  setQuantity(clientLineId: string, quantity: number): void;
  remove(clientLineId: string): void;
  rejected(lines: readonly { clientLineId: string; message: string }[]): void;
  clear(): void;
}

/**
 * The diners' cart (TAB-008): kept on the tablet so a restart loses nothing, and started afresh
 * whenever the guests change (`guestEpoch`, TAB-003).
 */
export function useCart(store: KeyValueStore, guestEpoch: number): Cart {
  const [lines, setLines] = useState<readonly CartLine[]>([]);
  useEffect(() => {
    let active = true;
    readJson(store, CART_KEY, parseCart).then(
      (saved) => {
        if (active) setLines(saved ?? []);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [store, guestEpoch]);
  const save = useCallback(
    (next: (current: readonly CartLine[]) => readonly CartLine[]) => {
      setLines((current) => {
        const updated = next(current);
        store.setItem(CART_KEY, JSON.stringify(updated)).catch(() => undefined);
        return updated;
      });
    },
    [store],
  );
  return {
    lines,
    add: (line) => {
      save((current) => addLine(current, line, uuidV4));
    },
    setQuantity: (clientLineId, quantity) => {
      save((current) =>
        quantity <= 0
          ? removeLine(current, clientLineId)
          : updateLine(current, clientLineId, { quantity }),
      );
    },
    remove: (clientLineId) => {
      save((current) => removeLine(current, clientLineId));
    },
    rejected: (rejectedLines) => {
      save((current) => markRejected(current, rejectedLines));
    },
    clear: () => {
      save(() => []);
    },
  };
}
