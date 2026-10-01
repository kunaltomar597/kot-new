'use client';

import type { MenuItem } from '@rp/contracts';
import type { QrOrderView } from '@rp/contracts/relay';
import { displayDateTime } from '@rp/domain';
import { useT } from './i18n';

/**
 * The diner's orders at this table and where each is (QR-007): sending, received, sent to the
 * kitchen with each dish's state (S), or the reason it was not taken. An order nobody picked up
 * in time says to call a waiter, at once, by the page's own clock as well as the relay's.
 */
export function Orders({
  orders,
  items,
  now,
}: {
  orders: readonly QrOrderView[];
  items: ReadonlyMap<string, MenuItem>;
  now: number;
}) {
  const t = useT();
  if (orders.length === 0) return null;
  return (
    <section className="qr-orders" aria-labelledby="qr-orders-title">
      <h2 id="qr-orders-title" className="qr-section__title">
        {t('qrSite.orders.title')}
      </h2>
      <ul>
        {orders.map((order) => {
          const status =
            order.status === 'SUBMITTED' && Date.parse(order.expiresAt) < now
              ? 'EXPIRED'
              : order.status;
          const states = new Map(
            (order.detail.items ?? []).map((line) => [line.clientLineId, line.state]),
          );
          const tone =
            status === 'SENT_TO_KITCHEN'
              ? 'success'
              : status === 'REJECTED' || status === 'EXPIRED'
                ? 'danger'
                : 'info';
          return (
            <li key={order.id} className="qr-order">
              <p className="qr-muted">
                {t('qrSite.orders.placed', displayDateTime(new Date(order.submittedAt)))}
              </p>
              <p role="status" className={`qr-order__status qr-order__status--${tone}`}>
                {t(`qrSite.orders.${status}`)}
              </p>
              {status === 'REJECTED' && order.detail.rejectionReason !== undefined ? (
                <p>{t('qrSite.orders.reason', { reason: order.detail.rejectionReason })}</p>
              ) : null}
              <ul className="qr-order__lines">
                {order.lines.map((line) => {
                  const state = states.get(line.clientLineId);
                  return (
                    <li key={line.clientLineId}>
                      <span>
                        {t('qrSite.orders.line', {
                          quantity: line.quantity,
                          name: items.get(line.itemId)?.name ?? '?',
                        })}
                      </span>
                      {state === undefined ? null : (
                        <span className="qr-order__state">
                          {t(`qrSite.orders.itemState.${state}`)}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
