'use client';

import type { MenuItem, RecommendationSource } from '@rp/contracts';
import type { QrMenuDocument, QrMenuResponse, QrOrderView } from '@rp/contracts/relay';
import { formatRupees, type Recommendation, unitPriceOf } from '@rp/domain';
import {
  addLine,
  type CartLine,
  cartTotal,
  channelItems,
  displayPrice,
  filterMenu,
  markRejected,
  menuCategories,
  needsOptions,
  type NewCartLine,
  qrBestSellers,
  qrSuggestions,
  removeLine,
  requestLines,
  searchMenu,
  selectable,
  type TabletFilter,
  unavailableReason,
  updateLine,
} from '@rp/ordering';
import { Button, ThemeRoot } from '@rp/ui-web';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CartSheet } from './CartSheet';
import { I18nProvider, useT } from './i18n';
import { ItemSheet } from './ItemSheet';
import { Orders } from './Orders';
import { sourceOf, Suggestions } from './Suggestions';
import { fetchMenu, fetchOrder, RelayCallError, submitOrder } from './relay';
import { browserId, newUuid, tableValue } from './storage';

type LoadedMenu = QrMenuResponse & { document: QrMenuDocument };

/** How often the page asks whether the menu, availability or the restaurant's presence changed. */
const MENU_REFRESH_MS = 60_000;
/** How often an order on its way is checked (QR-007). */
const ORDER_POLL_MS = 3_000;
const FILTERS: readonly TabletFilter[] = ['veg', 'jain', 'spicy', 'bestseller'];
/** How many suggestions a row shows (REC-005). */
const SUGGESTIONS = 4;
const NO_LINES: readonly CartLine[] = [];
const NO_ORDERS: readonly string[] = [];

/**
 * The QR menu page (P5-05, QR-002, QR-004 to QR-008): the table's menu with search and filters,
 * dishes with their options, the cart and sending the order, and where each order is. Read-only
 * with a banner while the restaurant is not heard from.
 */
export function QrMenu(props: { token: string; relayUrl: string; initial: LoadedMenu }) {
  return (
    <ThemeRoot theme="light" accent={props.initial.document.accentColor} className="qr-root">
      <I18nProvider>
        <MenuPage {...props} />
      </I18nProvider>
    </ThemeRoot>
  );
}

function MenuPage({
  token,
  relayUrl,
  initial,
}: {
  token: string;
  relayUrl: string;
  initial: LoadedMenu;
}) {
  const t = useT();
  // What was just added, for screen readers; the cart bar shows it to everyone else. (A toast
  // would cover the cart bar on a phone.)
  const [announced, setAnnounced] = useState('');
  const [menu, setMenu] = useState<LoadedMenu>(initial);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<ReadonlySet<TabletFilter>>(new Set());
  const [open, setOpen] = useState<
    { readonly item: MenuItem; readonly recommendation?: RecommendationSource } | undefined
  >();
  const [cartOpen, setCartOpen] = useState(false);
  // The cart and this table's orders survive a reload (kept in this browser only).
  const cart = useMemo(
    () =>
      tableValue<readonly CartLine[]>(
        token,
        'cart',
        (value) => (Array.isArray(value) ? (value as CartLine[]) : undefined),
        NO_LINES,
      ),
    [token],
  );
  const sent = useMemo(
    () =>
      tableValue<readonly string[]>(
        token,
        'orders',
        (value) =>
          Array.isArray(value)
            ? value.filter((id): id is string => typeof id === 'string')
            : undefined,
        NO_ORDERS,
      ),
    [token],
  );
  const lines = useSyncExternalStore(cart.subscribe, cart.get, () => cart.empty);
  const orderIds = useSyncExternalStore(sent.subscribe, sent.get, () => sent.empty);
  const [note, setNote] = useState('');
  const [name, setName] = useState('');
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const pendingKey = useRef<string | undefined>(undefined);
  const [orders, setOrders] = useState<ReadonlyMap<string, QrOrderView>>(new Map());
  const [now, setNow] = useState(() => Date.now());

  const document = menu.document;
  const items = useMemo(() => channelItems(document.menu, 'QR'), [document]);
  const byId = useMemo(
    () => new Map(document.menu.items.map((item) => [item.id, item])),
    [document],
  );
  const bestSellers = useMemo(() => qrBestSellers(document, new Date(now)), [document, now]);
  const shown = useMemo(
    () => filterMenu(searchMenu(items, query), filters, bestSellers),
    [items, query, filters, bestSellers],
  );
  // By menu section; a search's results stay in one list, best match first.
  const sections = useMemo(
    () =>
      query.trim() !== ''
        ? [{ id: 'results', name: t('qrSite.search'), items: shown, heading: false }]
        : menuCategories(document.menu, shown).map((category) => ({
            id: category.id,
            name: category.name,
            items: shown.filter((item) => item.categoryId === category.id),
            heading: true,
          })),
    [document, shown, query, t],
  );

  const changeLines = useCallback(
    (next: readonly CartLine[]) => {
      cart.set(next.length === 0 ? NO_LINES : next);
      // A changed order is a new order: it gets a new key when sent.
      pendingKey.current = undefined;
      setMessage(undefined);
    },
    [cart],
  );

  // QR-008: the menu, availability and the restaurant's presence, kept fresh.
  useEffect(() => {
    const timer = setInterval(() => {
      fetchMenu(relayUrl, token, menu.version).then(
        (fresh) => {
          setMenu((current) => ({
            ...fresh,
            document: fresh.document ?? current.document,
          }));
        },
        () => undefined,
      );
    }, MENU_REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [relayUrl, token, menu.version]);

  // QR-007: each order on its way, until it is settled.
  const unsettled = orderIds.filter((id) => {
    const order = orders.get(id);
    return (
      order === undefined ||
      order.status === 'SUBMITTED' ||
      order.status === 'RECEIVED' ||
      order.status === 'SENT_TO_KITCHEN'
    );
  });
  const unsettledKey = unsettled.join(',');
  useEffect(() => {
    if (unsettledKey === '') return;
    let stopped = false;
    const poll = () => {
      setNow(Date.now());
      for (const id of unsettledKey.split(',')) {
        fetchOrder(relayUrl, token, id).then(
          (order) => {
            if (!stopped) setOrders((current) => new Map([...current, [id, order]]));
          },
          () => undefined,
        );
      }
    };
    poll();
    const timer = setInterval(poll, ORDER_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [relayUrl, token, unsettledKey]);

  const add = (line: NewCartLine) => {
    changeLines(addLine(lines, line, newUuid));
    setOpen(undefined);
    setAnnounced(t('qrSite.added', { name: line.name }));
  };

  const quickAdd = (item: MenuItem, recommendation?: RecommendationSource) => {
    const def = selectable(document.menu, item);
    add({
      itemId: item.id,
      name: item.name,
      summary: '',
      quantity: 1,
      selection: {},
      instructions: '',
      unitPrice: unitPriceOf(def, {}),
      ...(recommendation !== undefined && { recommendation }),
    });
  };

  /** A suggestion pressed: added at once, or its options asked for first. */
  const pick = (item: MenuItem, suggestion: Recommendation) => {
    const recommendation = sourceOf(suggestion);
    if (needsOptions(document.menu, item)) setOpen({ item, recommendation });
    else quickAdd(item, recommendation);
  };

  const send = () => {
    setSending(true);
    setMessage(undefined);
    pendingKey.current ??= newUuid();
    const trimmedNote = note.trim();
    const trimmedName = name.trim();
    submitOrder(relayUrl, token, browserId(), {
      idempotencyKey: pendingKey.current,
      lines: requestLines(lines),
      ...(trimmedNote !== '' && { orderNote: trimmedNote }),
      ...(trimmedName !== '' && { customerName: trimmedName }),
    }).then(
      (answer) => {
        setSending(false);
        if (answer.status === 'REJECTED') {
          changeLines(markRejected(lines, answer.rejectedLines));
          setMessage(t('qrSite.cart.rejected'));
          void fetchMenu(relayUrl, token).then(
            (fresh) => {
              if (fresh.document !== null) setMenu({ ...fresh, document: fresh.document });
            },
            () => undefined,
          );
          return;
        }
        sent.set([answer.order.id, ...orderIds.filter((id) => id !== answer.order.id)]);
        setOrders((current) => new Map([...current, [answer.order.id, answer.order]]));
        changeLines([]);
        setNote('');
        setCartOpen(false);
      },
      (failure: unknown) => {
        setSending(false);
        if (failure instanceof RelayCallError && failure.code === 'RATE_LIMITED') {
          const seconds = Number(failure.details.retryAfterSeconds ?? 60);
          setMessage(t('qrSite.errors.rateLimited', { seconds }));
        } else if (failure instanceof RelayCallError && failure.code === 'RESTAURANT_OFFLINE') {
          setMenu((current) => ({ ...current, readOnly: true }));
          setMessage(t('qrSite.errors.offline'));
        } else if (failure instanceof RelayCallError && failure.code === 'NETWORK') {
          // The same key is sent again, so a retry never orders twice (ORD-013).
          setMessage(t('qrSite.errors.network'));
        } else {
          setMessage(t('qrSite.errors.generic'));
        }
      },
    );
  };

  const count = lines.reduce((total, line) => total + line.quantity, 0);
  const shownOrders = orderIds.flatMap((id) => {
    const order = orders.get(id);
    return order === undefined ? [] : [order];
  });
  // REC-005: nothing already ordered here (unless it may be had again), the veg filter honoured.
  const { suggestions } = qrSuggestions(document, {
    ordered: [
      ...lines.map((line) => line.itemId),
      ...shownOrders.flatMap((order) => order.lines.map((line) => line.itemId)),
    ],
    vegOnly: filters.has('veg'),
    now: new Date(now),
    limit: SUGGESTIONS,
  });
  const needsChoice = (item: MenuItem) => needsOptions(document.menu, item);

  return (
    <div className="qr-page">
      <header className="qr-header">
        <h1 className="qr-header__name">{document.restaurantName}</h1>
        <p className="qr-header__table">{t('qrSite.table', { label: menu.table.label })}</p>
      </header>
      {menu.readOnly ? (
        <p role="status" className="qr-notice qr-notice--warning qr-banner">
          {t('qrSite.readOnly')}
        </p>
      ) : null}

      <Orders orders={shownOrders} items={byId} now={now} />

      <div className="qr-tools">
        <label className="qr-search">
          <span className="qr-visually-hidden">{t('qrSite.search')}</span>
          <input
            type="search"
            value={query}
            placeholder={t('qrSite.searchHint')}
            aria-label={t('qrSite.search')}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </label>
        <fieldset className="qr-filters">
          <legend className="qr-visually-hidden">{t('qrSite.filters.legend')}</legend>
          {FILTERS.filter(
            (filter) => filter !== 'bestseller' || document.recommendations !== undefined,
          ).map((filter) => (
            <label key={filter} className="qr-chip">
              <input
                type="checkbox"
                checked={filters.has(filter)}
                onChange={(event) => {
                  const next = new Set(filters);
                  if (event.target.checked) next.add(filter);
                  else next.delete(filter);
                  setFilters(next);
                }}
              />
              <span>{t(`qrSite.filters.${filter}`)}</span>
            </label>
          ))}
        </fieldset>
        {sections.length > 1 && query === '' ? (
          <nav className="qr-categories" aria-label={t('qrSite.categories')}>
            {sections.map((section) => (
              <a key={section.id} href={`#c-${section.id}`}>
                {section.name}
              </a>
            ))}
          </nav>
        ) : null}
      </div>

      <main>
        {query.trim() === '' ? (
          <Suggestions
            title={count === 0 ? t('reco.row.menu') : t('reco.row.cart')}
            suggestions={suggestions}
            items={byId}
            readOnly={menu.readOnly}
            needsChoice={needsChoice}
            onPick={pick}
          />
        ) : null}
        {shown.length === 0 ? <p className="qr-muted qr-empty">{t('qrSite.noMatch')}</p> : null}
        {sections.map((section) => (
          <section
            key={section.id}
            id={`c-${section.id}`}
            className="qr-section"
            aria-label={section.name}
          >
            {section.heading ? <h2 className="qr-section__title">{section.name}</h2> : null}
            <ul className="qr-dishes">
              {section.items.map((item) => (
                <DishRow
                  key={item.id}
                  item={item}
                  needsChoice={needsOptions(document.menu, item)}
                  readOnly={menu.readOnly}
                  onChoose={() => {
                    setOpen({ item });
                  }}
                  onAdd={() => {
                    quickAdd(item);
                  }}
                />
              ))}
            </ul>
          </section>
        ))}
      </main>

      <p role="status" aria-live="polite" className="qr-visually-hidden">
        {announced}
      </p>
      {count === 0 ? null : (
        <div className="qr-cart-bar">
          <Button
            fullWidth
            size="lg"
            onClick={() => {
              setCartOpen(true);
            }}
          >
            {t('qrSite.cart.open', { count, total: formatRupees(cartTotal(lines)) })}
          </Button>
        </div>
      )}

      {open === undefined ? null : (
        <ItemSheet
          menu={document.menu}
          item={open.item}
          recommendation={open.recommendation}
          instructionMaxLength={document.instructionMaxLength}
          onClose={() => {
            setOpen(undefined);
          }}
          onAdd={add}
        />
      )}
      {cartOpen ? (
        <CartSheet
          lines={lines}
          menu={document.menu}
          priceMode={document.priceMode}
          note={note}
          name={name}
          readOnly={menu.readOnly}
          sending={sending}
          message={message}
          onQuantity={(id, quantity) => {
            changeLines(updateLine(lines, id, { quantity }));
          }}
          onRemove={(id) => {
            changeLines(removeLine(lines, id));
          }}
          onNote={setNote}
          onName={setName}
          onSend={send}
          onClose={() => {
            setCartOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function DishRow({
  item,
  needsChoice,
  readOnly,
  onChoose,
  onAdd,
}: {
  item: MenuItem;
  needsChoice: boolean;
  readOnly: boolean;
  onChoose: () => void;
  onAdd: () => void;
}) {
  const t = useT();
  const reason = unavailableReason(item);
  const foodType =
    item.foodType === 'VEG'
      ? t('qrSite.veg')
      : item.foodType === 'EGG'
        ? t('qrSite.egg')
        : t('qrSite.nonVeg');
  return (
    <li className="qr-dish" data-unavailable={reason === undefined ? undefined : true}>
      <div className="qr-dish__what">
        <p className="qr-dish__name">
          <span className="rp-food-mark" data-food={item.foodType} title={foodType} />
          <span>{item.name}</span>
          <span className="qr-visually-hidden">{foodType}</span>
        </p>
        {item.description === undefined ? null : (
          <p className="qr-dish__description">{item.description}</p>
        )}
        <p className="qr-dish__facts">
          <span className="qr-dish__price">{formatRupees(displayPrice(item))}</span>
          {item.spiceLevel > 0 ? (
            <span className="qr-muted">{t('qrSite.spice', { level: item.spiceLevel })}</span>
          ) : null}
        </p>
      </div>
      <div className="qr-dish__action">
        {reason !== undefined ? (
          <span className="qr-dish__unavailable">
            {reason === 'SOLD_OUT' ? t('qrSite.soldOut') : t('qrSite.notAvailable')}
          </span>
        ) : needsChoice ? (
          <Button
            variant="secondary"
            disabled={readOnly}
            aria-label={t('qrSite.chooseOf', { name: item.name })}
            onClick={onChoose}
          >
            {t('qrSite.choose')}
          </Button>
        ) : (
          <Button
            variant="secondary"
            disabled={readOnly}
            aria-label={t('qrSite.addOf', { name: item.name })}
            onClick={onAdd}
          >
            {t('qrSite.add')}
          </Button>
        )}
      </div>
    </li>
  );
}
