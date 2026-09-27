import { useDeviceSession, useT } from '@rp/mobile-shell';
import { useToast } from '@rp/ui-native';
import { useCallback, useEffect, useState } from 'react';
import { CartsProvider } from './carts';
import { TableScreen } from './TableScreen';
import { TablesScreen } from './TablesScreen';

type Place =
  { readonly screen: 'tables' } | { readonly screen: 'table'; readonly sessionId: string };

/** Says so when an order kept on the phone reaches the kitchen later, wherever the waiter is. */
function useOrdersSentLater() {
  const session = useDeviceSession();
  const toast = useToast();
  const t = useT();
  useEffect(
    () =>
      session.orders.onSent(({ draft, order, background }) => {
        if (!background) return;
        toast.show({
          title: t('mobile.order.sentLater', {
            number: order.orderNumber,
            table: draft.tableLabel,
          }),
          tone: 'success',
        });
      }),
    [session, toast, t],
  );
}

/** The signed-in waiter app: the tables, and one table's orders (WTR-002, WTR-003). */
export function SignedIn() {
  const [place, setPlace] = useState<Place>({ screen: 'tables' });
  const openTable = useCallback((sessionId: string) => {
    setPlace({ screen: 'table', sessionId });
  }, []);
  const back = useCallback(() => {
    setPlace({ screen: 'tables' });
  }, []);
  useOrdersSentLater();
  return (
    <CartsProvider>
      {place.screen === 'tables' ? (
        <TablesScreen onOpenTable={openTable} />
      ) : (
        <TableScreen key={place.sessionId} sessionId={place.sessionId} onBack={back} />
      )}
    </CartsProvider>
  );
}
