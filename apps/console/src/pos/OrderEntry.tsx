import type { MenuItem, MenuSnapshot, OrderView } from '@rp/contracts';
import {
  Button,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  LoadingState,
  MenuItemCard,
  Money,
  QuantityStepper,
  StatusChip,
  TextField,
  useToast,
} from '@rp/ui-web';
import { useState } from 'react';
import { useConsole } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useLive } from '../app/use-live.js';
import {
  addLine,
  type CartLine,
  cartTotal,
  markRejected,
  removeLine,
  requestLines,
  updateLine,
} from './cart.js';
import { ItemDialog } from './ItemDialog.js';
import {
  comboOf,
  displayPrice,
  needsOptions,
  posCategories,
  posItems,
  visibleItems,
} from './menu-view.js';

/** Who the order is for: a seated table session, or a takeaway customer (TBL-008). */
export type OrderTarget =
  | { readonly kind: 'table'; readonly sessionId: string; readonly label: string }
  | { readonly kind: 'takeaway' };

const newId = () => crypto.randomUUID();

const affectsMenu = (type: string) =>
  type === 'MenuPublished' || type === 'ItemAvailabilityChanged';
const affectsOrders = (type: string) =>
  /^(Order|KotCreated$|ItemStatusChanged$|TableMoved$|BillSettled$)/.test(type);

/**
 * Order entry on the POS (ORD-001, MENU-012): browse or search the menu, choose options, build the
 * cart with notes, and send it to the kitchen once, however many times the button is pressed or
 * the network retries (ORD-013). What was sent shows each item's live state (ORD-010).
 */
export function OrderEntry({ target, onBack }: { target: OrderTarget; onBack: () => void }) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const menu = useLive(() => controller.api.getMenu(), affectsMenu);
  const orders = useLive(
    async () =>
      target.kind === 'table'
        ? (await controller.api.listSessionOrders({ params: { sessionId: target.sessionId } }))
            .orders
        : (await controller.api.listTakeawayOrders()).orders,
    affectsOrders,
  );
  const [cart, setCart] = useState<CartLine[]>([]);
  // One key per cart: a retry after a lost answer is recognised by the server (ORD-013).
  const [idempotencyKey, setIdempotencyKey] = useState(newId);
  const [customerName, setCustomerName] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const [choosing, setChoosing] = useState<MenuItem | undefined>();

  const changeCart = (next: CartLine[]) => {
    setCart(next);
    setIdempotencyKey(newId());
  };

  const send = async () => {
    setSending(true);
    setNotice(undefined);
    try {
      const result = await controller.api.submitOrder({
        body: {
          idempotencyKey,
          source: 'POS',
          orderType: target.kind === 'table' ? 'DINE_IN' : 'TAKEAWAY',
          ...(target.kind === 'table' && { tableSessionId: target.sessionId }),
          ...(target.kind === 'takeaway' &&
            customerName.trim() !== '' && { customerName: customerName.trim() }),
          lines: requestLines(cart),
        },
      });
      if (result.status === 'PARTIALLY_REJECTED') {
        setCart(markRejected(cart, result.rejectedLines));
        setIdempotencyKey(newId());
        setNotice(t('pos.result.rejected'));
        return;
      }
      let title = t('pos.result.sent', { number: result.orderNumber });
      if (target.kind === 'takeaway') {
        const order = await controller.api.getOrder({ params: { orderId: result.orderId } });
        if (order.takeawayToken !== null) {
          title = t('pos.result.takeaway', {
            token: order.takeawayToken,
            number: result.orderNumber,
          });
        }
      }
      toast.show({ title, tone: 'success' });
      setCart([]);
      setCustomerName('');
      setIdempotencyKey(newId());
      orders.reload();
    } catch (error) {
      // The same key is kept, so sending again cannot create a second order.
      setNotice(t('pos.result.notSent', { message: messageOf(error, t) }));
    } finally {
      setSending(false);
    }
  };

  const title =
    target.kind === 'table' ? t('pos.table.title', { table: target.label }) : t('pos.takeaway');

  return (
    <section className="pos-order" aria-labelledby="pos-order-title">
      <header className="pos-order__header">
        <Button variant="ghost" startIcon={<Icon name="close" />} onClick={onBack}>
          {t('pos.backToTables')}
        </Button>
        <h2 id="pos-order-title" className="pos-floor__heading">
          {title}
        </h2>
      </header>
      <div className="pos-order__body">
        <div className="pos-order__menu">
          {menu.data.status === 'loading' ? <LoadingState title={t('states.loading')} /> : null}
          {menu.data.status === 'error' ? (
            <ErrorState
              title={messageOf(menu.data.error, t)}
              action={<Button onClick={menu.reload}>{t('states.retry')}</Button>}
            />
          ) : null}
          {menu.data.status === 'ready' ? (
            <MenuBrowser
              menu={menu.data.value}
              onChoose={(item, snapshot) => {
                if (needsOptions(snapshot, item)) {
                  setChoosing(item);
                  return;
                }
                changeCart(
                  addLine(
                    cart,
                    {
                      itemId: item.id,
                      name: item.name,
                      summary: '',
                      quantity: 1,
                      selection: {},
                      instructions: '',
                      unitPrice: item.basePrice,
                    },
                    newId,
                  ),
                );
              }}
            />
          ) : null}
        </div>
        <aside className="pos-order__side" aria-label={t('pos.cart.title')}>
          <Cart lines={cart} onChange={changeCart} disabled={sending} />
          {target.kind === 'takeaway' ? (
            <TextField
              label={t('pos.cart.customer')}
              value={customerName}
              maxLength={60}
              onChange={(event) => {
                setCustomerName(event.target.value);
              }}
            />
          ) : null}
          {notice === undefined ? null : (
            <p role="alert" className="console-notice console-notice--danger">
              {notice}
            </p>
          )}
          <Button
            size="lg"
            loading={sending}
            disabled={cart.length === 0}
            onClick={() => {
              void send();
            }}
          >
            {t('pos.cart.send')}
          </Button>
          <SentOrders target={target} data={orders.data} />
        </aside>
      </div>
      {choosing !== undefined && menu.data.status === 'ready' ? (
        <ItemDialog
          menu={menu.data.value}
          item={choosing}
          onClose={() => {
            setChoosing(undefined);
          }}
          onAdd={(line) => {
            changeCart(addLine(cart, line, newId));
            setChoosing(undefined);
          }}
        />
      ) : null}
    </section>
  );
}

function MenuBrowser({
  menu,
  onChoose,
}: {
  menu: MenuSnapshot;
  onChoose: (item: MenuItem, menu: MenuSnapshot) => void;
}) {
  const t = useT();
  const items = posItems(menu);
  const categories = posCategories(menu, items);
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState<string | undefined>(categories[0]?.id);
  const shown = visibleItems(items, query, categoryId);

  if (items.length === 0) return <EmptyState title={t('pos.menu.empty')} />;

  return (
    <div className="pos-menu">
      <TextField
        label={t('pos.menu.search')}
        type="search"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
      />
      {query.trim() === '' ? (
        <nav aria-label={t('pos.menu.categories')} className="pos-menu__categories">
          {categories.map((category) => (
            <Button
              key={category.id}
              variant={category.id === categoryId ? 'primary' : 'secondary'}
              aria-pressed={category.id === categoryId}
              onClick={() => {
                setCategoryId(category.id);
              }}
            >
              {category.name}
            </Button>
          ))}
        </nav>
      ) : null}
      {shown.length === 0 ? (
        <EmptyState title={t('pos.menu.noResults', { query: query.trim() })} />
      ) : (
        <div className="pos-menu__items">
          {shown.map((item) => (
            <MenuItemCard
              key={item.id}
              name={item.name}
              price={displayPrice(item)}
              foodType={item.foodType}
              foodTypeLabel={t(`pos.menu.foodType.${item.foodType}`)}
              {...noteOf(menu, item, t)}
              onSelect={() => {
                onChoose(item, menu);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function noteOf(
  menu: MenuSnapshot,
  item: MenuItem,
  t: ReturnType<typeof useT>,
): { note?: string; unavailable?: string } {
  if (item.stockCount === 0) return { unavailable: t('pos.menu.soldOut') };
  if (!item.available) return { unavailable: t('pos.menu.notAvailable') };
  if (item.stockCount !== null) return { note: t('pos.menu.left', { count: item.stockCount }) };
  if (comboOf(menu, item) !== undefined) return { note: t('pos.menu.combo') };
  if (needsOptions(menu, item)) return { note: t('pos.menu.options') };
  return {};
}

function Cart({
  lines,
  onChange,
  disabled,
}: {
  lines: readonly CartLine[];
  onChange: (lines: CartLine[]) => void;
  disabled: boolean;
}) {
  const t = useT();
  return (
    <div className="pos-cart">
      <h3 className="pos-cart__title">{t('pos.cart.title')}</h3>
      {lines.length === 0 ? <p className="pos-floor__summary">{t('pos.cart.empty')}</p> : null}
      <ul className="pos-cart__lines">
        {lines.map((line) => (
          <li
            key={line.clientLineId}
            className="pos-cart__line"
            data-error={line.error !== undefined || undefined}
          >
            <div className="pos-cart__line-head">
              <span className="pos-cart__name">{line.name}</span>
              <Money paise={line.unitPrice * line.quantity} />
            </div>
            {line.summary === '' ? null : <span className="pos-cart__summary">{line.summary}</span>}
            <div className="pos-cart__line-controls">
              <QuantityStepper
                value={line.quantity}
                onChange={(quantity) => {
                  onChange(updateLine(lines, line.clientLineId, { quantity }));
                }}
                label={t('pos.item.quantityOf', { name: line.name })}
                decreaseLabel={t('pos.item.fewer')}
                increaseLabel={t('pos.item.more')}
                disabled={disabled}
              />
              <IconButton
                label={t('pos.cart.remove', { name: line.name })}
                icon={<Icon name="close" />}
                disabled={disabled}
                onClick={() => {
                  onChange(removeLine(lines, line.clientLineId));
                }}
              />
            </div>
            <TextField
              label={t('pos.item.instructions')}
              value={line.instructions}
              maxLength={200}
              disabled={disabled}
              onChange={(event) => {
                onChange(
                  updateLine(lines, line.clientLineId, { instructions: event.target.value }),
                );
              }}
            />
            {line.error === undefined ? null : (
              <p className="console-notice console-notice--danger">{line.error}</p>
            )}
          </li>
        ))}
      </ul>
      {lines.length === 0 ? null : (
        <div className="pos-cart__total">
          <span>{t('pos.cart.total')}</span>
          <Money paise={cartTotal(lines)} size="lg" strong />
          <span className="pos-cart__summary">{t('pos.cart.estimateNote')}</span>
        </div>
      )}
    </div>
  );
}

function SentOrders({
  target,
  data,
}: {
  target: OrderTarget;
  data: ReturnType<typeof useLive<OrderView[]>>['data'];
}) {
  const t = useT();
  if (data.status !== 'ready') return null;
  const heading = target.kind === 'table' ? t('pos.sent.title') : t('pos.sent.openTakeaway');
  return (
    <section className="pos-sent" aria-label={heading}>
      <h3 className="pos-cart__title">{heading}</h3>
      {data.value.length === 0 ? <p className="pos-floor__summary">{t('pos.sent.none')}</p> : null}
      {data.value.map((order) => (
        <article
          key={order.id}
          className="pos-sent__order"
          aria-label={t('pos.sent.order', { number: order.orderNumber })}
        >
          <h4 className="pos-sent__heading">
            {t('pos.sent.order', { number: order.orderNumber })}
            {order.takeawayToken === null
              ? null
              : ` · ${t('pos.sent.token', { token: order.takeawayToken })}`}
            {order.customerName === null ? null : ` · ${order.customerName}`}
          </h4>
          <ul className="pos-sent__items">
            {order.items
              .filter((item) => item.parentOrderItemId === null)
              .map((item) => (
                <li key={item.id} className="pos-sent__item">
                  <span>
                    {item.quantity} × {item.name}
                    {item.variantName === null ? '' : ` (${item.variantName})`}
                  </span>
                  <StatusChip state={item.state} label={t(`pos.itemState.${item.state}`)} />
                </li>
              ))}
          </ul>
        </article>
      ))}
    </section>
  );
}
