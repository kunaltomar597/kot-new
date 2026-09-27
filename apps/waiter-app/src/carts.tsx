import type { CartLine } from '@rp/ordering';
import { createContext, type ReactNode, use, useCallback, useMemo, useState } from 'react';

type CartChange = (lines: readonly CartLine[]) => readonly CartLine[];

interface Carts {
  readonly carts: ReadonlyMap<string, readonly CartLine[]>;
  readonly change: (sessionId: string, change: CartChange) => void;
}

const CartsContext = createContext<Carts | null>(null);

/**
 * The new items of each table, by table session, while the waiter is signed in: leaving a table
 * and coming back keeps what was being ordered there. Items become an order on the device only
 * when the waiter sends them (WTR-012).
 */
export function CartsProvider({ children }: { children: ReactNode }) {
  const [carts, setCarts] = useState<ReadonlyMap<string, readonly CartLine[]>>(new Map());
  const change = useCallback((sessionId: string, update: CartChange) => {
    setCarts((current) => {
      const next = new Map(current);
      const lines = update(current.get(sessionId) ?? []);
      if (lines.length === 0) next.delete(sessionId);
      else next.set(sessionId, lines);
      return next;
    });
  }, []);
  const value = useMemo(() => ({ carts, change }), [carts, change]);
  return <CartsContext value={value}>{children}</CartsContext>;
}

/** One table's new items, and a way to change them. */
export function useCart(sessionId: string): [readonly CartLine[], (change: CartChange) => void] {
  const carts = use(CartsContext);
  if (carts === null) throw new Error('Wrap the signed-in screens in <CartsProvider>.');
  const { change } = carts;
  const update = useCallback(
    (next: CartChange) => {
      change(sessionId, next);
    },
    [change, sessionId],
  );
  return [carts.carts.get(sessionId) ?? [], update];
}
