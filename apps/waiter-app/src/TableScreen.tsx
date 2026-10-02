import { newIdempotencyKey, uuidV4 } from '@rp/api-client';
import type { MenuItem, OrderView, RecommendationSource, TableOverviewEntry } from '@rp/contracts';
import { fontSize, fontWeight, spacing } from '@rp/design-tokens';
import { formatRupees } from '@rp/domain';
import { type OrderDraft, SuggestionTracker } from '@rp/mobile-core';
import {
  ItemSheet,
  messageOf,
  Note,
  OverrideCancelled,
  Screen,
  SuggestionRow,
  useDeviceSession,
  useLive,
  useMenu,
  useNow,
  useOverride,
  useSessionState,
  useSuggestions,
  useT,
  useUnsentOrders,
} from '@rp/mobile-shell';
import {
  addLine,
  affectsFloor,
  againLine,
  type CartLine,
  cartTotal,
  freeTables,
  lineActions,
  type LineProblem,
  lineProblems,
  markRejected,
  needsOptions,
  requestLines,
  tileAlert,
  tileDetails,
} from '@rp/ordering';
import { Button, SegmentedControl, useTheme, useToast, weight } from '@rp/ui-native';
import { useEffect, useMemo, useState } from 'react';
import { BackHandler, StyleSheet, Text, View } from 'react-native';
import { CartList } from './CartList';
import { useCart } from './carts';
import { EndItemSheet, type Ending } from './EndItemSheet';
import { MenuBrowser } from './MenuBrowser';
import { mayMove, MoveSheet } from './MoveSheet';
import { SentOrders } from './SentOrders';
import { Approvals } from './Approvals';
import { ServiceRequests } from './ServiceRequests';
import { UnsentOrders } from './UnsentOrders';

type TableView = 'order' | 'menu';
type SentLine = OrderView['items'][number];

/** Seated times move on every half minute. */
const CLOCK_MS = 30_000;

/** Events after which a table's sent orders are read again, including their tickets' printing. */
const affectsOrders = (eventType: string) =>
  /^(Order|Kot|ItemStatusChanged$|TableMoved$|BillSettled$)/.test(eventType);

/**
 * One table in the waiter app (WTR-003, WTR-005, WTR-007 to WTR-009, WTR-012): its new items and
 * the menu to add them from, what was already sent with each ticket's delivery and each item's
 * state, to mark picked up or served, cancel, void (with a manager's PIN on this phone) or order
 * again, its orders not yet sent, its open requests, and moving it or asking for the bill. Opened
 * by the table session, so a moved table stays open here under its new name.
 */
export function TableScreen({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const session = useDeviceSession();
  const { person } = useSessionState();
  const t = useT();
  const { colors } = useTheme();
  const toast = useToast();
  const now = useNow(CLOCK_MS);
  const menu = useMenu();
  const [cart, setCart] = useCart(sessionId);
  const [view, setView] = useState<TableView>('order');
  const [choosing, setChoosing] = useState<MenuItem | undefined>();
  /** The suggestion the dish being chosen came from (REC-008). */
  const [choosingSource, setChoosingSource] = useState<RecommendationSource | undefined>();
  /** What the waiter does with suggestions, sent in batches (REC-008). */
  const tracker = useMemo(
    () =>
      new SuggestionTracker({
        send: async (events) => {
          await session.api.recordRecommendationEvents({
            body: { tableSessionId: sessionId, channel: 'WAITER_APP', events },
          });
        },
      }),
    [session, sessionId],
  );
  useEffect(
    () => () => {
      void tracker.stop();
    },
    [tracker],
  );
  const cartIds = cart.map((line) => line.itemId);
  const upsell = useSuggestions(
    () =>
      session.api.getRecommendations({
        query: { tableSessionId: sessionId, channel: 'WAITER_APP', cart: cartIds, limit: 4 },
      }),
    cartIds.join(','),
    menu !== null && menu !== undefined,
  );
  const [moving, setMoving] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const [asking, setAsking] = useState(false);
  const [busyLines, setBusyLines] = useState<ReadonlySet<string>>(new Set());
  const [ending, setEnding] = useState<{ line: SentLine; ending: Ending } | undefined>();
  const { withOverride, sheet: approval } = useOverride();
  const tables = useLive(() => session.api.getTableOverview(), affectsFloor);
  const orders = useLive(
    async () => (await session.api.listSessionOrders({ params: { sessionId } })).orders,
    affectsOrders,
  );
  const unsent = useUnsentOrders();
  const drafts = unsent.filter((entry) => entry.body.request.tableSessionId === sessionId);
  const problems = useMemo(
    () =>
      menu === null || menu === undefined
        ? new Map<string, LineProblem>()
        : lineProblems(menu, cart, 'WAITER_APP', now),
    [menu, cart, now],
  );

  // An order for this table reached the kitchen, now or later on reconnect: show it at once.
  const reloadOrders = orders.reload;
  useEffect(
    () =>
      session.orders.onSent(({ draft }) => {
        if (draft.request.tableSessionId === sessionId) reloadOrders();
      }),
    [session, sessionId, reloadOrders],
  );

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, [onBack]);

  if (person === undefined) return null;
  const table: TableOverviewEntry | undefined =
    tables.data.status === 'ready'
      ? tables.data.value.tables.find((candidate) => candidate.session?.id === sessionId)
      : undefined;
  const closed = tables.data.status === 'ready' && table === undefined;
  const label = table?.label ?? drafts[0]?.body.tableLabel ?? '';

  const add = (line: Omit<CartLine, 'clientLineId' | 'error'>, source?: RecommendationSource) => {
    setNotice(undefined);
    setCart((lines) =>
      addLine(lines, source === undefined ? line : { ...line, recommendation: source }, uuidV4),
    );
    // WTR-011: a suggestion the waiter put in the order (REC-008).
    if (source !== undefined) {
      tracker.record({ kind: 'ADD_TO_CART', itemId: line.itemId, ...source });
    }
  };

  const choose = (item: MenuItem, source?: RecommendationSource) => {
    if (menu === null || menu === undefined) return;
    if (needsOptions(menu, item)) {
      setChoosing(item);
      setChoosingSource(source);
      return;
    }
    add(
      {
        itemId: item.id,
        name: item.name,
        summary: '',
        quantity: 1,
        selection: {},
        instructions: '',
        unitPrice: item.basePrice,
      },
      source,
    );
  };

  const again = (order: OrderView, line: OrderView['items'][number]) => {
    if (menu === null || menu === undefined) return;
    const repeat = againLine(menu, order, line, 'WAITER_APP');
    if (repeat !== undefined) {
      add(repeat);
      return;
    }
    // The menu changed how it is ordered: choose again.
    const item = menu.items.find((candidate) => candidate.id === line.itemId);
    if (item !== undefined) setChoosing(item);
  };

  /** A refused order's items come back to be changed, marked with the server's reasons. */
  const putBack = (draft: OrderDraft) => {
    const problem = draft.problem;
    const lines =
      problem?.kind === 'LINES' ? markRejected(draft.lines, problem.lines) : [...draft.lines];
    setCart((current) => [...lines, ...current]);
    setNotice(
      problem?.kind === 'REFUSED'
        ? t('pos.result.notSent', { message: problem.message })
        : t('pos.result.rejected'),
    );
    setView('order');
  };

  const send = () => {
    if (table === undefined || cart.length === 0) return;
    const lines = cart;
    const draft: OrderDraft = {
      staffId: person.id,
      tableLabel: table.label,
      // A new key per order: the outbox resends this one with the same key until it is taken.
      request: {
        idempotencyKey: newIdempotencyKey(),
        source: 'WAITER_APP',
        orderType: 'DINE_IN',
        tableSessionId: sessionId,
        lines: requestLines(lines),
      },
      lines,
    };
    setNotice(undefined);
    setCart(() => []);
    setView('order');
    session.orders.submit(draft).then(
      async (result) => {
        if (result.status === 'SENT') {
          toast.show({
            title: t('pos.result.sent', { number: result.order.orderNumber }),
            tone: 'success',
          });
          return;
        }
        if (result.status === 'QUEUED') {
          toast.show({ title: t('mobile.order.queued'), tone: 'warning' });
          return;
        }
        const refused = await session.orders.takeBack(draft.request.idempotencyKey);
        if (refused !== undefined) putBack(refused);
      },
      (failure: unknown) => {
        // The order could not even be kept on the phone: the items stay here.
        setCart((current) => [...lines, ...current]);
        setNotice(t('pos.result.notSent', { message: messageOf(failure, t) }));
      },
    );
  };

  const working = (ids: readonly string[], busy: boolean) => {
    setBusyLines((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (busy) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const settled = () => {
    orders.reload();
    tables.reload();
  };

  /** Picked up from the pass or served at the table (WTR-007, KDS-007). */
  const step = (line: SentLine, event: 'PICK_UP' | 'SERVE') => {
    setNotice(undefined);
    working([line.id], true);
    session.api.setOrderItemStatus({ params: { orderItemId: line.id }, body: { event } }).then(
      () => {
        working([line.id], false);
        settled();
      },
      (failure: unknown) => {
        working([line.id], false);
        setNotice(messageOf(failure, t));
        settled();
      },
    );
  };

  /** Several dishes carried to the table at once, one after another; stops at a refusal. */
  /** ORD-016: the order's held items go to the kitchen now. */
  const fire = async (order: { readonly id: string }) => {
    setNotice(undefined);
    try {
      await session.api.fireOrder({ params: { orderId: order.id }, body: {} });
      toast.show({ title: t('pos.sent.fired'), tone: 'success' });
    } catch (failure) {
      setNotice(messageOf(failure, t));
    } finally {
      settled();
    }
  };

  const serveAll = async (lines: readonly SentLine[]) => {
    setNotice(undefined);
    const ids = lines.map((line) => line.id);
    working(ids, true);
    let served = 0;
    try {
      for (const line of lines) {
        await session.api.setOrderItemStatus({
          params: { orderItemId: line.id },
          body: { event: 'SERVE' },
        });
        served += 1;
      }
      toast.show({ title: t('mobile.item.servedAll', { count: served }), tone: 'success' });
    } catch (failure) {
      setNotice(messageOf(failure, t));
    } finally {
      working(ids, false);
      settled();
    }
  };

  /**
   * Cancels a dish the kitchen has not started, or voids one it has (ORD-011). A waiter's void
   * goes through a manager's PIN on this phone when the server asks for it (WTR-009, AUTH-011).
   */
  const end = (line: SentLine, kind: Ending, reason: string) => {
    setEnding(undefined);
    setNotice(undefined);
    working([line.id], true);
    const params = { orderItemId: line.id };
    const done =
      kind === 'CANCEL'
        ? session.api.cancelOrderItem({ params, body: { reason } })
        : withOverride(
            (overrideToken) =>
              session.api.voidOrderItem({
                params,
                body: { reason },
                ...(overrideToken !== undefined && { overrideToken }),
              }),
            { entityType: 'order_item', entityId: line.id },
          );
    done.then(
      () => {
        working([line.id], false);
        toast.show({
          title: t(kind === 'CANCEL' ? 'mobile.item.cancelled' : 'mobile.item.voided', {
            name: line.name,
          }),
          tone: 'success',
        });
        settled();
      },
      (failure: unknown) => {
        working([line.id], false);
        setNotice(
          failure instanceof OverrideCancelled
            ? t('mobile.item.notApproved', { name: line.name })
            : messageOf(failure, t),
        );
        settled();
      },
    );
  };

  const requestBill = () => {
    if (table === undefined) return;
    setAsking(true);
    setNotice(undefined);
    session.api.requestBill({ params: { sessionId } }).then(
      () => {
        setAsking(false);
        toast.show({
          title: t('mobile.tables.billRequested', { table: table.label }),
          tone: 'success',
        });
        tables.reload();
      },
      (failure: unknown) => {
        setAsking(false);
        setNotice(messageOf(failure, t));
      },
    );
  };

  const count = cart.reduce((total, line) => total + line.quantity, 0);
  const blocked = problems.size > 0;
  const alert = table === undefined ? undefined : tileAlert(table, t);
  const ownTable = table?.session?.waiterId === person.id;

  return (
    <Screen
      title={t('pos.table.title', { table: label })}
      actions={
        <Button variant="ghost" onPress={onBack}>
          {t('pos.backToTables')}
        </Button>
      }
      {...(!closed &&
        cart.length > 0 && {
          footer: (
            <>
              {blocked ? <Note tone="danger">{t('mobile.order.blocked')}</Note> : null}
              <Text style={[styles.summary, { color: colors.text }]}>
                {t('mobile.order.summary', { count, total: formatRupees(cartTotal(cart)) })}
              </Text>
              <Button
                size="lg"
                fullWidth
                disabled={blocked || table === undefined}
                testID="send-kot"
                onPress={send}
              >
                {t('mobile.order.send')}
              </Button>
            </>
          ),
        })}
    >
      {tables.data.status === 'error' ? (
        <>
          <Note tone="danger">{messageOf(tables.data.error, t)}</Note>
          <Button variant="secondary" onPress={tables.reload}>
            {t('states.retry')}
          </Button>
        </>
      ) : null}
      {tables.data.status === 'loading' ? <Note>{t('states.loading')}</Note> : null}
      {closed ? <Note tone="text">{t('mobile.order.closed')}</Note> : null}
      {table === undefined ? null : (
        <>
          <Note>
            {[t(`pos.tableState.${table.state}`), ...tileDetails(table, now, t)].join(' · ')}
          </Note>
          {alert === undefined ? null : <Note tone="danger">{alert}</Note>}
          <View style={styles.actions}>
            {mayMove(table, person) ? (
              <Button
                variant="secondary"
                style={styles.grow}
                onPress={() => {
                  setMoving(true);
                }}
              >
                {t('pos.table.move')}
              </Button>
            ) : null}
            {table.state === 'OCCUPIED' ? (
              <Button
                variant="secondary"
                style={styles.grow}
                loading={asking}
                onPress={requestBill}
              >
                {t('mobile.tables.requestBill')}
              </Button>
            ) : null}
          </View>
        </>
      )}
      {notice === undefined ? null : <Note tone="danger">{notice}</Note>}
      <Approvals sessionId={sessionId} />
      <ServiceRequests show={(request) => request.tableSessionId === sessionId} />
      <UnsentOrders entries={drafts} personId={person.id} onChange={putBack} />
      {closed ? null : (
        <>
          <SegmentedControl
            label={t('mobile.order.views')}
            options={[
              { id: 'order', label: t('mobile.order.orderTab', { count }) },
              { id: 'menu', label: t('mobile.order.menuTab') },
            ]}
            value={view}
            onChange={(next) => {
              setView(next === 'menu' ? 'menu' : 'order');
            }}
          />
          {view === 'menu' ? (
            menu === undefined ? (
              <Note>{t('states.loading')}</Note>
            ) : menu === null ? (
              <Note>{t('mobile.order.menuWaiting')}</Note>
            ) : (
              <MenuBrowser menu={menu} onChoose={choose} />
            )
          ) : (
            <>
              {menu !== null && menu !== undefined && (
                <SuggestionRow
                  title={t('reco.row.upsell')}
                  suggestions={upsell}
                  menu={menu}
                  tracker={tracker}
                  testID="suggestions-upsell"
                  onChoose={choose}
                />
              )}
              <Text accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>
                {t('pos.cart.title')}
              </Text>
              {cart.length === 0 ? (
                <>
                  <Note>{t('mobile.order.cartEmpty')}</Note>
                  <Button
                    variant="secondary"
                    onPress={() => {
                      setView('menu');
                    }}
                  >
                    {t('mobile.order.addItems')}
                  </Button>
                </>
              ) : (
                <CartList
                  lines={cart}
                  problems={problems}
                  onChange={(lines) => {
                    setCart(() => lines);
                  }}
                />
              )}
              <SentOrders
                data={orders.data}
                menu={menu}
                actions={{
                  role: person.role,
                  ownTable,
                  busy: busyLines,
                  onStep: step,
                  onServeAll: (lines) => {
                    void serveAll(lines);
                  },
                  onEnd: (line, kind) => {
                    setEnding({ line, ending: kind });
                  },
                  onFire: (order) => {
                    void fire(order);
                  },
                }}
                onAgain={again}
                onRetry={orders.reload}
              />
            </>
          )}
        </>
      )}
      {choosing !== undefined && menu !== null && menu !== undefined ? (
        <ItemSheet
          menu={menu}
          item={choosing}
          onClose={() => {
            setChoosing(undefined);
            setChoosingSource(undefined);
          }}
          onAdd={(line) => {
            add(line, choosingSource);
            setChoosing(undefined);
            setChoosingSource(undefined);
          }}
        />
      ) : null}
      {moving && table !== undefined && tables.data.status === 'ready' ? (
        <MoveSheet
          table={table}
          sessionId={sessionId}
          freeTables={freeTables(tables.data.value)}
          onClose={() => {
            setMoving(false);
          }}
          onMoved={(message) => {
            setMoving(false);
            toast.show({ title: message, tone: 'success' });
            tables.reload();
          }}
        />
      ) : null}
      {ending === undefined ? null : (
        <EndItemSheet
          line={ending.line}
          ending={ending.ending}
          managerNeeded={lineActions(ending.line, person.role, ownTable).void === 'OVERRIDE'}
          onClose={() => {
            setEnding(undefined);
          }}
          onConfirm={(reason) => {
            end(ending.line, ending.ending, reason);
          }}
        />
      )}
      {approval}
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: spacing[2] },
  grow: { flex: 1 },
  heading: { fontSize: fontSize.lg, fontWeight: weight(fontWeight.semibold) },
  summary: { fontSize: fontSize.md },
});
