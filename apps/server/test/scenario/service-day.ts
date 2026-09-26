import { randomUUID } from 'node:crypto';
import { ApiClient, ApiRequestError, generateWebCryptoDeviceKey } from '@rp/api-client';
import type {
  BillView,
  DayEndView,
  GstSummaryResponse,
  InvoiceRegisterResponse,
  InvoiceView,
  MenuSnapshot,
  OrderLineRequest,
  StaffTile,
  AuditVerifyResponse,
} from '@rp/contracts';
import type { Capability } from '@rp/domain';

/**
 * The Phase 1 exit scenario (P1-14): a simulated service day through the same client the POS
 * uses. Two paired terminals: one for the manager (kitchen steps, approvals, day-end), one for the
 * cashier. About 100 orders across tables and takeaway, with variants, modifiers and combos,
 * cancellations, voids with a manager's approval, discounts within and above the cashier's limit,
 * split bills, reprints, a cancelled and re-issued invoice and table moves; then the shift and the
 * day are closed and the results are returned for checking.
 *
 * The run is repeatable: every random choice comes from `seed`. It runs against a throwaway test
 * server in CI and against a real install on the lab rig (see `service-day.int.test.ts`).
 */

export interface ServiceDayPerson {
  /** Display name on the staff tiles, e.g. "Vikram (Manager)". */
  readonly name: string;
  readonly pin: string;
}

export interface ServiceDayOptions {
  readonly baseUrl: string;
  /** Returns a pairing code for each new terminal (the first may be the bootstrap code). */
  readonly pairingCodes:
    readonly [string, string] | ((manager: ApiClient | null) => Promise<string>);
  readonly manager: ServiceDayPerson;
  readonly cashier: ServiceDayPerson;
  readonly orders?: number;
  readonly seed?: number;
  readonly log?: (line: string) => void;
}

export interface ServiceDayCounts {
  orders: number;
  takeawayOrders: number;
  tables: number;
  lines: number;
  combos: number;
  modifierLines: number;
  variantLines: number;
  cancelledItems: number;
  voidedItems: number;
  discounts: number;
  approvedDiscounts: number;
  splitBills: number;
  reprints: number;
  voidedInvoices: number;
  moves: number;
  payments: number;
}

export interface ServiceDayResult {
  readonly businessDate: string;
  readonly counts: ServiceDayCounts;
  /** Every invoice the day issued, as the POS saw it last. */
  readonly invoices: readonly InvoiceView[];
  /** Sum of all payments recorded, in paise. */
  readonly paid: number;
  readonly cashPaid: number;
  readonly dayEnd: DayEndView;
  readonly gst: GstSummaryResponse;
  readonly register: InvoiceRegisterResponse;
  readonly audit: AuditVerifyResponse;
  readonly shiftVariance: number | null;
}

/** mulberry32: a small, fast, seeded generator. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export async function runServiceDay(options: ServiceDayOptions): Promise<ServiceDayResult> {
  const random = generator(options.seed ?? 20_260_926);
  const chance = (probability: number) => random() < probability;
  const pick = <T>(values: readonly T[]): T => {
    const value = values[Math.floor(random() * values.length)];
    if (value === undefined) throw new Error('Nothing to pick from');
    return value;
  };
  const log = options.log ?? (() => undefined);
  const counts: ServiceDayCounts = {
    orders: 0,
    takeawayOrders: 0,
    tables: 0,
    lines: 0,
    combos: 0,
    modifierLines: 0,
    variantLines: 0,
    cancelledItems: 0,
    voidedItems: 0,
    discounts: 0,
    approvedDiscounts: 0,
    splitBills: 0,
    reprints: 0,
    voidedInvoices: 0,
    moves: 0,
    payments: 0,
  };

  // ------------------------------------------------------------ terminals and people
  const codeFor = async (index: 0 | 1, manager: ApiClient | null): Promise<string> =>
    typeof options.pairingCodes === 'function'
      ? options.pairingCodes(manager)
      : options.pairingCodes[index];
  const terminal = async (code: string, name: string): Promise<ApiClient> => {
    const { key } = await generateWebCryptoDeviceKey();
    const client = new ApiClient({ baseUrl: options.baseUrl, signer: key });
    await client.pair({ code, key, appVersion: `scenario ${name}` });
    return client;
  };
  const signIn = async (client: ApiClient, person: ServiceDayPerson): Promise<StaffTile> => {
    const tiles = await client.api.listStaffTiles();
    const tile = tiles.staff.find((entry) => entry.displayName === person.name);
    if (tile === undefined) throw new Error(`No staff tile called "${person.name}"`);
    await client.signInWithPin({ staffId: tile.staffId, pin: person.pin });
    return tile;
  };
  const manager = await terminal(await codeFor(0, null), 'manager');
  const managerTile = await signIn(manager, options.manager);
  const cashier = await terminal(await codeFor(1, manager), 'cashier');
  await signIn(cashier, options.cashier);

  // A real counter asks for a manager's PIN a few times an hour; this day runs in seconds, so the
  // per-device attempt limit is raised for the run and put back afterwards (both audited).
  const ATTEMPTS = 'auth.attemptsPerMinutePerDevice';
  const settings = await manager.api.listSettings();
  const attemptsBefore = settings.settings.find((setting) => setting.key === ATTEMPTS)?.value;
  await manager.api.updateSetting({
    params: { key: ATTEMPTS },
    body: { value: 100, reason: 'Phase 1 exit scenario' },
  });

  /** A manager's PIN at the cashier's terminal (AUTH-011). */
  const approval = async (capability: Capability, entityType: string, entityId: string) =>
    (
      await cashier.api.grantOverride({
        body: {
          approverStaffId: managerTile.staffId,
          pin: options.manager.pin,
          capability,
          entityType,
          entityId,
        },
      })
    ).overrideToken;

  // ------------------------------------------------------------ the menu and the floor
  const menu: MenuSnapshot = await cashier.api.getMenu();
  const groups = new Map(menu.modifierGroups.map((group) => [group.id, group]));
  const combos = new Map(menu.combos.map((combo) => [combo.itemId, combo]));
  const sellable = menu.items.filter(
    (item) => item.available && !item.archived && item.channels.includes('POS'),
  );
  if (sellable.length < 5) throw new Error('The menu needs at least five items for the scenario');

  const line = (): OrderLineRequest => {
    const item = pick(sellable);
    const request: {
      clientLineId: string;
      itemId: string;
      quantity: number;
      variantId?: string;
      modifiers: { groupId: string; optionIds: string[] }[];
      comboChoices?: string[];
    } = {
      clientLineId: randomUUID(),
      itemId: item.id,
      quantity: chance(0.2) ? 2 : 1,
      modifiers: [],
    };
    if (item.variants.length > 0) {
      request.variantId = pick(item.variants).id;
      counts.variantLines += 1;
    }
    for (const groupId of item.modifierGroupIds) {
      const group = groups.get(groupId);
      if (group === undefined) continue;
      const wanted = Math.max(group.minSelections, chance(0.5) ? 1 : 0);
      const count = Math.min(wanted, group.maxSelections, group.options.length);
      if (count === 0) continue;
      const options_ = [...group.options].sort(() => random() - 0.5).slice(0, count);
      request.modifiers.push({ groupId, optionIds: options_.map((option) => option.id) });
    }
    if (request.modifiers.length > 0) counts.modifierLines += 1;
    const combo = combos.get(item.id);
    if (combo !== undefined) {
      request.comboChoices = combo.components.flatMap((component) =>
        component.kind === 'CHOICE' ? [pick(component.itemIds)] : [],
      );
      counts.combos += 1;
    }
    counts.lines += 1;
    return request;
  };

  const submit = async (target: { tableSessionId: string } | { takeaway: string }) => {
    const lines = Array.from({ length: 1 + Math.floor(random() * 3) }, line);
    const idempotencyKey = randomUUID();
    const body = {
      idempotencyKey,
      source: 'POS' as const,
      ...('tableSessionId' in target
        ? { orderType: 'DINE_IN' as const, tableSessionId: target.tableSessionId }
        : { orderType: 'TAKEAWAY' as const, customerName: target.takeaway }),
      lines,
    };
    const result = await cashier.api.submitOrder({ body });
    if (result.status !== 'ACCEPTED') {
      throw new Error(`Order refused: ${JSON.stringify(result.rejectedLines)}`);
    }
    // A retry with the same key never creates a second order (ORD-013).
    if (chance(0.1)) {
      const again = await cashier.api.submitOrder({ body });
      if (again.status !== 'ACCEPTED' || !again.replayed || again.orderId !== result.orderId) {
        throw new Error('A retried order was not replayed');
      }
    }
    counts.orders += 1;
    return cashier.api.getOrder({ params: { orderId: result.orderId } });
  };

  /** Cancels a line before the kitchen starts, or voids one after with a manager's approval. */
  const endSomething = async (orderId: string) => {
    const order = await cashier.api.getOrder({ params: { orderId } });
    const lines = order.items.filter(
      (item) => item.parentOrderItemId === null && item.state === 'SENT',
    );
    // Keep at least one line so the bill is not empty.
    if (lines.length < 2) return;
    const target = pick(lines);
    if (chance(0.5)) {
      await cashier.api.cancelOrderItem({
        params: { orderItemId: target.id },
        body: { reason: 'Guest changed their mind' },
      });
      counts.cancelledItems += 1;
    } else if (order.items.every((item) => item.parentOrderItemId !== target.id)) {
      await manager.api.setOrderItemStatus({
        params: { orderItemId: target.id },
        body: { event: 'START_PREPARING' },
      });
      const overrideToken = await approval('ITEM_VOID_AFTER_PREP', 'order_item', target.id);
      await cashier.api.voidOrderItem({
        params: { orderItemId: target.id },
        body: { reason: 'Dropped in the kitchen' },
        overrideToken,
      });
      counts.voidedItems += 1;
    }
  };

  const invoices = new Map<string, InvoiceView>();
  let paid = 0;
  let cashPaid = 0;

  const pay = async (invoice: InvoiceView) => {
    const status = await cashier.api.getInvoicePayments({ params: { id: invoice.id } });
    if (status.remaining === 0) return;
    const payments = chance(0.3)
      ? [
          { mode: 'UPI' as const, amount: Math.floor(status.remaining / 2) || status.remaining },
          ...(Math.floor(status.remaining / 2) > 0
            ? [
                {
                  mode: 'CASH' as const,
                  amount: status.remaining - Math.floor(status.remaining / 2),
                },
              ]
            : []),
        ]
      : [{ mode: pick(['CASH', 'CARD', 'UPI'] as const), amount: status.remaining }];
    const body = {
      idempotencyKey: randomUUID(),
      payments: payments.map((payment) => ({
        ...payment,
        ...(payment.mode === 'CASH' && { tendered: Math.ceil(payment.amount / 10_000) * 10_000 }),
      })),
    };
    const result = await cashier.api.recordPayments({ params: { id: invoice.id }, body });
    // A retried payment set is recorded once (BILL-008).
    if (chance(0.1)) await cashier.api.recordPayments({ params: { id: invoice.id }, body });
    if (result.remaining !== 0) throw new Error(`Invoice ${invoice.invoiceNumber} is not settled`);
    for (const payment of payments) {
      paid += payment.amount;
      if (payment.mode === 'CASH') cashPaid += payment.amount;
    }
    counts.payments += payments.length;
  };

  // The bill printer when one is set in settings; otherwise the first printer (a fresh install).
  const printers = (await manager.api.listPrinters()).printers;
  const printTo = { printerId: printers[0]?.id ?? null };
  const print = async (invoice: InvoiceView) => {
    const printed = await cashier.api
      .printInvoice({ params: { id: invoice.id }, body: {} })
      .catch(async (error: unknown) => {
        if (!(error instanceof ApiRequestError) || error.status !== 422) throw error;
        return cashier.api.printInvoice({ params: { id: invoice.id }, body: printTo });
      });
    if (printed.duplicate) throw new Error('A first print was marked DUPLICATE');
    if (chance(0.15)) {
      const again = await cashier.api.printInvoice({ params: { id: invoice.id }, body: printTo });
      // Once a copy has come out, every later copy says DUPLICATE (BILL-009).
      if (printed.printed && !again.duplicate) {
        throw new Error('A reprint was not marked DUPLICATE');
      }
      counts.reprints += 1;
    }
  };

  const settle = async (bill: BillView) => {
    let current = bill;
    if (chance(0.2)) {
      await cashier.api.addBillDiscount({
        params: { id: current.id },
        body: {
          orderItemId: null,
          kind: 'PERCENT',
          rateBp: 500,
          amount: null,
          reason: 'Regular guest',
        },
      });
      counts.discounts += 1;
    } else if (chance(0.1)) {
      // Above the cashier's limit: a manager approves (AUTH-011).
      const discount = {
        orderItemId: null,
        kind: 'PERCENT' as const,
        rateBp: 2_000,
        amount: null,
        reason: 'Birthday',
      };
      try {
        await cashier.api.addBillDiscount({ params: { id: current.id }, body: discount });
        throw new Error('A 20 % discount went through without approval');
      } catch (error) {
        if (!(error instanceof ApiRequestError) || error.code !== 'OVERRIDE_REQUIRED') throw error;
      }
      const overrideToken = await approval('DISCOUNT_ABOVE_LIMIT', 'bill', current.id);
      await cashier.api.addBillDiscount({
        params: { id: current.id },
        body: discount,
        overrideToken,
      });
      counts.approvedDiscounts += 1;
    }
    current = await cashier.api.getBill({ params: { id: current.id } });
    let issued: InvoiceView[];
    if (chance(0.15) && current.lines.length > 0) {
      const result = await cashier.api.splitBill({
        params: { id: current.id },
        body: { mode: 'EQUAL', parts: 2, seriesId: null },
      });
      issued = result.invoices;
      counts.splitBills += 1;
    } else {
      issued = [await cashier.api.issueInvoice({ params: { id: current.id }, body: {} })];
    }
    const first = issued[0];
    if (issued.length === 1 && first !== undefined && chance(0.08)) {
      // Printed with a mistake: cancelled with a manager's approval and issued again (BILL-010).
      await print(first);
      const overrideToken = await approval('INVOICE_VOID', 'invoice', first.id);
      const voided = await cashier.api.voidInvoice({
        params: { id: first.id },
        body: { reason: 'Wrong table on the bill' },
        overrideToken,
      });
      invoices.set(voided.id, voided);
      counts.voidedInvoices += 1;
      issued = [await cashier.api.issueInvoice({ params: { id: current.id }, body: {} })];
    }
    for (const invoice of issued) {
      await print(invoice);
      await pay(invoice);
      invoices.set(invoice.id, await cashier.api.getInvoice({ params: { id: invoice.id } }));
    }
  };

  // ------------------------------------------------------------ the day
  const shift = await cashier.api.openShift({ body: { openingFloat: 200_000 } });
  const target = options.orders ?? 100;
  let takeawayNumber = 0;
  while (counts.orders < target) {
    if (chance(0.3)) {
      takeawayNumber += 1;
      const order = await submit({ takeaway: `Guest ${String(takeawayNumber)}` });
      counts.takeawayOrders += 1;
      if (chance(0.2)) await endSomething(order.id);
      const bill = await cashier.api.openBill({ body: { orderId: order.id } });
      await settle(bill);
      continue;
    }
    const overview = await cashier.api.getTableOverview();
    const free = overview.tables.filter((table) => table.state === 'FREE');
    if (free.length === 0) throw new Error('No free table');
    const table = pick(free);
    const session = await cashier.api.openTable({
      params: { tableId: table.tableId },
      body: { covers: 1 + Math.floor(random() * 6) },
    });
    counts.tables += 1;
    let sessionId = session.id;
    const rounds = 1 + Math.floor(random() * 3);
    for (let round = 0; round < rounds && counts.orders < target; round += 1) {
      const order = await submit({ tableSessionId: sessionId });
      if (chance(0.25)) await endSomething(order.id);
    }
    if (chance(0.1)) {
      const others = (await cashier.api.getTableOverview()).tables.filter(
        (entry) => entry.state === 'FREE',
      );
      if (others.length > 0) {
        const moved = await cashier.api.moveTable({
          params: { sessionId },
          body: { toTableId: pick(others).tableId },
        });
        sessionId = moved.id;
        counts.moves += 1;
      }
    }
    const bill = await cashier.api.openBill({ body: { tableSessionId: sessionId } });
    await settle(bill);
  }
  log(`Service done: ${JSON.stringify(counts)}`);

  // ------------------------------------------------------------ closing
  const current = await cashier.api.getCurrentShift();
  if (current.shift === null) throw new Error('The shift disappeared');
  const closedShift = await cashier.api.closeShift({
    params: { id: shift.id },
    body: { countedCash: current.shift.expectedCash },
  });
  const preview = await manager.api.previewDayEnd();
  const dayEnd = await manager.api.closeDay({
    body: { businessDate: preview.businessDate, carryForwardTables: false },
  });
  const range = { from: preview.businessDate, to: preview.businessDate };
  const [gst, register, audit] = await Promise.all([
    manager.api.getGstSummary({ query: range }),
    manager.api.getInvoiceRegister({ query: range }),
    manager.api.verifyAuditChain(),
  ]);
  log(`Day ${preview.businessDate} closed with ${String(register.invoices.length)} invoices`);
  await manager.api.updateSetting({
    params: { key: ATTEMPTS },
    body: { value: attemptsBefore, reason: 'Phase 1 exit scenario finished' },
  });
  await Promise.all([cashier.signOut(), manager.signOut()]);
  return {
    businessDate: preview.businessDate,
    counts,
    invoices: [...invoices.values()],
    paid,
    cashPaid,
    dayEnd,
    gst,
    register,
    audit,
    shiftVariance: closedShift.variance,
  };
}
