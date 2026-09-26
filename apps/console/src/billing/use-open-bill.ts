import { useToast } from '@rp/ui-web';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { useConsole } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';

/**
 * Opens (or finds) the bill of a table session or a takeaway order and goes to it (BILL-001).
 */
export function useOpenBill(): {
  openBill: (target: { tableSessionId: string } | { orderId: string }) => void;
  opening: boolean;
} {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);
  const openBill = useCallback(
    (target: { tableSessionId: string } | { orderId: string }) => {
      setOpening(true);
      controller.api
        .openBill({ body: target })
        .then(
          (bill) => navigate(`/pos/bill/${bill.id}`),
          (failure: unknown) => {
            toast.show({ title: messageOf(failure, t), tone: 'danger' });
          },
        )
        .finally(() => {
          setOpening(false);
        });
    },
    [controller, navigate, t, toast],
  );
  return { openBill, opening };
}
