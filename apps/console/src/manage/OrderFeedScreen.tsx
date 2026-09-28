import type { OrderFeedEntry, OrderFeedResponse } from '@rp/contracts';
import {
  type DelayThresholds,
  filterOrderFeed,
  itemDelay,
  minutesSince,
  ORDER_SOURCES,
  type OrderFeedFilter,
  summarizeOrderFeed,
} from '@rp/domain';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  Select,
  StatusChip,
} from '@rp/ui-web';
import { useSearchParams } from 'react-router';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useNow } from '../app/use-now.js';
import {
  FILTER_PARAMS,
  filterFromSearch,
  isFiltered,
  lineName,
  lineTiming,
  orderPlace,
  tableLabelOf,
} from './order-feed-view.js';
import { serverNow, useOrderFeed } from './use-order-feed.js';

/**
 * The live order feed (P4-01, MGR-003): every order with something waiting for approval, in the
 * kitchen or at the pass, oldest first, each dish with its station, state and time. Filters by
 * station, waiter, source and table (kept in the address) and "Delayed only"; late dishes and
 * their orders are marked with an icon and words, not colour alone (NFR-U05). It is read again
 * after every order, kitchen and table event, and the times move on between reads.
 */
export function OrderFeedScreen() {
  const t = useT();
  const { data, reload } = useOrderFeed();
  const now = useNow(15_000);
  const [search, setSearch] = useSearchParams();

  const heading = (
    <h2 id="dashboard-orders" className="dashboard-section__heading">
      {t('dashboard.orders.title')}
    </h2>
  );
  if (data.status === 'loading') {
    return (
      <section className="dashboard-section" aria-labelledby="dashboard-orders">
        {heading}
        <LoadingState title={t('states.loading')} />
      </section>
    );
  }
  if (data.status === 'error') {
    return (
      <section className="dashboard-section" aria-labelledby="dashboard-orders">
        {heading}
        <ErrorState
          title={t('dashboard.orders.loadFailed')}
          description={messageOf(data.error, t)}
          action={<Button onClick={reload}>{t('states.retry')}</Button>}
        />
      </section>
    );
  }

  const { feed, receivedAt } = data.value;
  const nowMs = serverNow(feed, receivedAt, now);
  const filter = filterFromSearch(search, feed);
  const shown = filterOrderFeed(feed.orders, filter, nowMs, feed.settings);
  const summary = summarizeOrderFeed(shown, nowMs, feed.settings);
  const change = (param: string, value: string | undefined) => {
    const next = new URLSearchParams(search);
    if (value === undefined || value === '') next.delete(param);
    else next.set(param, value);
    if (param === FILTER_PARAMS.table && value === undefined) next.delete(FILTER_PARAMS.tableLabel);
    setSearch(next, { replace: true });
  };
  const clear = () => {
    setSearch(new URLSearchParams(), { replace: true });
  };

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-orders">
      {heading}
      <FeedFilters feed={feed} filter={filter} search={search} onChange={change} onClear={clear} />
      <p className="dashboard-feed__summary">
        {t('dashboard.orders.summary', {
          orders: summary.orders,
          ready: summary.ready,
          delayed: summary.delayed,
        })}
      </p>
      {shown.length === 0 ? (
        <EmptyState
          title={isFiltered(filter) ? t('dashboard.orders.noneMatch') : t('dashboard.orders.none')}
          action={
            isFiltered(filter) ? (
              <Button variant="secondary" onClick={clear}>
                {t('dashboard.orders.clear')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="dashboard-feed__orders">
          {shown.map((order) => (
            <li key={order.orderId}>
              <OrderCard order={order} nowMs={nowMs} thresholds={feed.settings} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FeedFilters({
  feed,
  filter,
  search,
  onChange,
  onClear,
}: {
  feed: OrderFeedResponse;
  filter: OrderFeedFilter;
  search: URLSearchParams;
  onChange: (param: string, value: string | undefined) => void;
  onClear: () => void;
}) {
  const t = useT();
  return (
    <div
      role="group"
      aria-label={t('dashboard.orders.filters')}
      className="dashboard-feed__filters"
    >
      <Select
        label={t('dashboard.orders.station')}
        value={filter.stationId ?? ''}
        options={[
          { value: '', label: t('dashboard.orders.allStations') },
          ...feed.stations.map((station) => ({ value: station.id, label: station.name })),
        ]}
        onChange={(event) => {
          onChange(FILTER_PARAMS.station, event.target.value);
        }}
      />
      <Select
        label={t('dashboard.orders.waiter')}
        value={filter.waiterId ?? ''}
        options={[
          { value: '', label: t('dashboard.orders.allWaiters') },
          ...feed.waiters.map((person) => ({ value: person.id, label: person.name })),
        ]}
        onChange={(event) => {
          onChange(FILTER_PARAMS.waiter, event.target.value);
        }}
      />
      <Select
        label={t('dashboard.orders.source')}
        value={filter.source ?? ''}
        options={[
          { value: '', label: t('dashboard.orders.allSources') },
          ...ORDER_SOURCES.map((source) => ({ value: source, label: t(`kds.source.${source}`) })),
        ]}
        onChange={(event) => {
          onChange(FILTER_PARAMS.source, event.target.value);
        }}
      />
      <label className="console-check dashboard-feed__delayed">
        <input
          type="checkbox"
          checked={filter.delayedOnly === true}
          onChange={(event) => {
            onChange(FILTER_PARAMS.delayed, event.target.checked ? '1' : undefined);
          }}
        />
        {t('dashboard.orders.delayedOnly')}
      </label>
      {filter.tableId === undefined ? null : (
        <p className="dashboard-feed__table">
          <span>
            {t('dashboard.orders.table', {
              table: tableLabelOf(search, filter.tableId, feed.orders),
            })}
          </span>
          <Button
            variant="secondary"
            onClick={() => {
              onChange(FILTER_PARAMS.table, undefined);
            }}
          >
            {t('dashboard.orders.allTables')}
          </Button>
        </p>
      )}
      {isFiltered(filter) ? (
        <Button variant="ghost" onClick={onClear}>
          {t('dashboard.orders.clear')}
        </Button>
      ) : null}
    </div>
  );
}

/** One order: where it goes, where it came from, who serves it, and each dish's progress. */
function OrderCard({
  order,
  nowMs,
  thresholds,
}: {
  order: OrderFeedEntry;
  nowMs: number;
  thresholds: DelayThresholds;
}) {
  const t = useT();
  const late = order.items.some((item) => itemDelay(item, nowMs, thresholds) !== null);
  const headingId = `feed-order-${order.orderId}`;
  const meta = [
    t(`kds.source.${order.source}`),
    ...(order.waiterName === null
      ? []
      : [t('dashboard.orders.waiterName', { name: order.waiterName })]),
    t('dashboard.orders.placed', { minutes: minutesSince(order.createdAt, nowMs) }),
  ];
  return (
    <article className="feed-order" data-delayed={late || undefined} aria-labelledby={headingId}>
      <header className="feed-order__header">
        <h3 id={headingId} className="feed-order__title">
          {orderPlace(order, t)} · {t('dashboard.orders.order', { number: order.orderNumber })}
        </h3>
        {late ? (
          <Badge tone="danger" variant="solid" icon={<Icon name="warning" />}>
            {t('dashboard.orders.delayed')}
          </Badge>
        ) : null}
      </header>
      <p className="feed-order__meta">{meta.join(' · ')}</p>
      <ul className="feed-order__items">
        {order.items.map((item) => {
          const timing = lineTiming(item, nowMs, thresholds, t);
          return (
            <li
              key={item.orderItemId}
              className="feed-line"
              data-delayed={timing.delay === null ? undefined : true}
            >
              <span className="feed-line__name">{lineName(item, t)}</span>
              <span className="feed-line__where">
                {item.comboName === null
                  ? item.stationName
                  : `${item.stationName} · ${t('dashboard.orders.inCombo', { combo: item.comboName })}`}
              </span>
              <StatusChip state={item.state} label={t(`pos.itemState.${item.state}`)} />
              {timing.text === null ? null : (
                <span className="feed-line__time">
                  {timing.delay === null ? null : <Icon name="warning" />}
                  {timing.text}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </article>
  );
}
