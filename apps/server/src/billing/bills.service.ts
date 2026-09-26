import { Injectable } from '@nestjs/common';
import type { BillCustomerRequest, BillView, DiscountRequest } from '@rp/contracts';

/** A discount request after validation, defaults applied. */
export type ParsedDiscount = ReturnType<typeof DiscountRequest.parse>;
import {
  decideDiscount,
  type DiscountValue,
  effectiveDiscountRateBp,
  isBillable,
  normaliseGstin,
} from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import { authErrors } from '../auth/auth-errors.js';
import { AuthService } from '../auth/auth.service.js';
import type { Principal } from '../auth/principal.js';
import { currentBusinessDate, dbDate } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import type { Bill } from '../generated/prisma/client.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  type ActiveDiscount,
  type BillableItem,
  type BillSettings,
  type CalculatedBill,
  calculateBill,
  describeItem,
  isComplimentary,
} from './bill-calculation.js';

type Client = PrismaService | TransactionClient;

/** Everything a bill is priced from, loaded in one place. */
export interface BillContext {
  readonly bill: Bill;
  readonly tableId: string | null;
  readonly tableLabel: string | null;
  readonly items: readonly BillableItem[];
  /** Items still waiting for a manager's approval (TAB/QR orders), which block printing. */
  readonly awaitingApproval: number;
  readonly discounts: readonly (ActiveDiscount & {
    reason: string;
    appliedById: string;
    approvedById: string | null;
  })[];
  readonly settings: BillSettings & {
    readonly serviceChargeEnabled: boolean;
    readonly rateBp: number;
  };
  readonly taxGroups: ReadonlyMap<string, { name: string; sacCode: string | null }>;
  readonly calculated: CalculatedBill;
}

function billNotFound(): AppError {
  return new AppError(404, 'BILL_NOT_FOUND', 'There is no such bill.');
}

function billPrinted(): AppError {
  return new AppError(
    409,
    'BILL_ALREADY_PRINTED',
    'This bill is printed. Edit the printed bill instead (manager PIN needed).',
  );
}

/**
 * Bills before printing (P1-10a, BILL-001, BILL-005, BILL-006, BILL-011). A bill belongs to one
 * table session or one takeaway order and is priced on the server from the items as ordered,
 * never from anything a client sends (ORD-014). Discounts, the service charge choice and the
 * customer's details are kept on it until the invoice is issued. Every change runs under a row
 * lock on the bill and is audited (AUD-001).
 */
@Injectable()
export class BillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly auth: AuthService,
  ) {}

  /** Opens the bill of a table session or takeaway order, or returns the one already open. */
  async open(
    principal: Principal,
    target: { tableSessionId?: string | undefined; orderId?: string | undefined },
  ): Promise<BillView> {
    const billId = await this.prisma.transaction(async (tx) => {
      if (target.tableSessionId !== undefined) {
        const session = await tx.tableSession.findFirst({
          where: { id: target.tableSessionId, restaurantId: principal.restaurantId },
          select: { id: true, status: true, bill: { select: { id: true } } },
        });
        if (session === null) {
          throw new AppError(404, 'SESSION_NOT_FOUND', 'There is no such table session.');
        }
        if (session.bill !== null) return session.bill.id;
        if (session.status !== 'OPEN') {
          throw new AppError(404, 'SESSION_NOT_FOUND', 'This table session is closed.');
        }
        return this.create(tx, principal, { tableSessionId: session.id });
      }
      const order = await tx.order.findFirst({
        where: { id: target.orderId ?? '', restaurantId: principal.restaurantId },
        select: { id: true, orderType: true, bill: { select: { id: true } } },
      });
      if (order?.orderType !== 'TAKEAWAY') {
        throw new AppError(
          404,
          'ORDER_NOT_FOUND',
          'There is no such takeaway order. Dine-in orders are billed by table.',
        );
      }
      if (order.bill !== null) return order.bill.id;
      return this.create(tx, principal, { orderId: order.id });
    });
    return this.view(principal.restaurantId, billId);
  }

  async view(restaurantId: string, billId: string): Promise<BillView> {
    const [context, invoices] = await Promise.all([
      this.context(this.prisma, restaurantId, billId),
      this.prisma.invoice.findMany({
        where: { billId, restaurantId },
        select: { id: true },
        orderBy: { issuedAt: 'asc' },
      }),
    ]);
    return this.toView(
      context,
      invoices.map((invoice) => invoice.id),
    );
  }

  /** An item or bill discount, within the role's limit or with a manager's approval (BILL-005). */
  async addDiscount(
    principal: Principal,
    billId: string,
    request: ParsedDiscount,
    overrideToken: string | undefined,
  ): Promise<BillView> {
    await this.prisma.transaction(async (tx) => {
      const context = await this.lockedOpenBill(tx, principal.restaurantId, billId);
      const { result } = context.calculated;
      let base: number;
      if (request.orderItemId !== null) {
        const line = result.lines.find((candidate) => candidate.id === request.orderItemId);
        if (line === undefined) {
          throw new AppError(404, 'BILL_LINE_NOT_FOUND', 'That item is not on this bill.');
        }
        if (context.calculated.itemDiscountOf.has(line.id)) {
          throw new AppError(
            409,
            'DISCOUNT_EXISTS',
            'This item already has a discount. Take it back first to give another.',
          );
        }
        base = line.grossAmount;
      } else {
        if (context.calculated.billDiscount !== null) {
          throw new AppError(
            409,
            'DISCOUNT_EXISTS',
            'This bill already has a bill discount. Take it back first to give another.',
          );
        }
        base = result.subtotal - result.itemDiscountTotal;
      }
      if (base === 0) {
        throw new AppError(409, 'NOTHING_TO_DISCOUNT', 'There is nothing left to discount.');
      }
      const value: DiscountValue =
        request.kind === 'PERCENT'
          ? { kind: 'PERCENT', rateBp: request.rateBp ?? 0 }
          : { kind: 'FLAT', amount: request.amount ?? 0 };
      if (value.kind === 'FLAT' && value.amount > base) {
        throw new AppError(
          422,
          'DISCOUNT_EXCEEDS_AMOUNT',
          'A flat discount cannot be more than what it applies to.',
          { base },
        );
      }
      const rateBp = effectiveDiscountRateBp(base, value);
      const approverId = await this.approve(principal, billId, rateBp, overrideToken);

      const discount = await tx.discount.create({
        data: {
          id: newId(),
          restaurantId: principal.restaurantId,
          businessDate: context.bill.businessDate,
          billId,
          orderItemId: request.orderItemId,
          kind: request.kind,
          rateBp: request.rateBp,
          amount: 0,
          reason: request.reason,
          appliedById: principal.staffId,
          approvedById: approverId,
        },
      });
      // Record what it takes off now; the invoice records the final amount.
      const after = await this.context(tx, principal.restaurantId, billId);
      const amount = this.discountAmount(after, discount.id);
      await tx.discount.update({ where: { id: discount.id }, data: { amount } });
      await this.audit.record(tx, {
        action: isComplimentary({ ...discount, amount })
          ? 'ITEM_COMPLIMENTARY'
          : 'DISCOUNT_APPLIED',
        entityType: 'bill',
        entityId: billId,
        actorId: principal.staffId,
        approverId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        before: { grandTotal: result.grandTotal },
        after: {
          discountId: discount.id,
          orderItemId: request.orderItemId,
          kind: request.kind,
          rateBp: request.rateBp,
          amount,
          effectiveRateBp: rateBp,
          grandTotal: after.calculated.result.grandTotal,
        },
        reason: request.reason,
      });
    });
    return this.view(principal.restaurantId, billId);
  }

  async revokeDiscount(
    principal: Principal,
    billId: string,
    discountId: string,
    reason: string,
  ): Promise<BillView> {
    await this.prisma.transaction(async (tx) => {
      const context = await this.lockedOpenBill(tx, principal.restaurantId, billId);
      const discount = context.discounts.find((candidate) => candidate.id === discountId);
      if (discount === undefined) {
        throw new AppError(404, 'DISCOUNT_NOT_FOUND', 'There is no such discount on this bill.');
      }
      await tx.discount.update({
        where: { id: discountId },
        data: { revokedAt: new Date(), revokedById: principal.staffId },
      });
      const after = await this.context(tx, principal.restaurantId, billId);
      await this.audit.record(tx, {
        action: 'DISCOUNT_REVOKED',
        entityType: 'bill',
        entityId: billId,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        before: {
          discountId,
          amount: discount.amount,
          grandTotal: context.calculated.result.grandTotal,
        },
        after: { grandTotal: after.calculated.result.grandTotal },
        reason,
      });
    });
    return this.view(principal.restaurantId, billId);
  }

  /** Removes the voluntary service charge at the diner's request, or puts it back (BILL-006). */
  async setServiceCharge(
    principal: Principal,
    billId: string,
    removed: boolean,
    reason: string,
  ): Promise<BillView> {
    await this.prisma.transaction(async (tx) => {
      const context = await this.lockedOpenBill(tx, principal.restaurantId, billId);
      if (context.bill.serviceChargeRemoved === removed) return;
      await tx.bill.update({ where: { id: billId }, data: { serviceChargeRemoved: removed } });
      await this.audit.record(tx, {
        action: removed ? 'SERVICE_CHARGE_REMOVED' : 'SERVICE_CHARGE_RESTORED',
        entityType: 'bill',
        entityId: billId,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        before: {
          serviceChargeRemoved: !removed,
          serviceCharge: context.calculated.result.serviceCharge,
        },
        after: { serviceChargeRemoved: removed },
        reason,
      });
    });
    return this.view(principal.restaurantId, billId);
  }

  /** The customer's details for the invoice (BILL-011); the phone is kept only with consent. */
  async setCustomer(
    principal: Principal,
    billId: string,
    customer: BillCustomerRequest,
  ): Promise<BillView> {
    await this.prisma.transaction(async (tx) => {
      await this.lockedOpenBill(tx, principal.restaurantId, billId);
      await tx.bill.update({
        where: { id: billId },
        data: {
          customerName: customer.name,
          customerPhone: customer.phoneConsent ? customer.phone : null,
          customerPhoneConsent: customer.phone !== null && customer.phoneConsent,
          customerGstin: customer.gstin === null ? null : normaliseGstin(customer.gstin),
        },
      });
    });
    return this.view(principal.restaurantId, billId);
  }

  /** Locks the bill row (and the table, for dine-in) and checks it can still change. */
  async lockedOpenBill(
    tx: TransactionClient,
    restaurantId: string,
    billId: string,
  ): Promise<BillContext> {
    const found = await tx.bill.findFirst({
      where: { id: billId, restaurantId },
      select: { tableSession: { select: { tableId: true } } },
    });
    if (found === null) throw billNotFound();
    // Tables before bills, the order order submission and table moves use.
    if (found.tableSession !== null) {
      await tx.$queryRaw`SELECT 1 AS locked FROM tables WHERE id = ${found.tableSession.tableId}::uuid FOR UPDATE`;
    }
    await tx.$queryRaw`SELECT 1 AS locked FROM bills WHERE id = ${billId}::uuid FOR UPDATE`;
    const context = await this.context(tx, restaurantId, billId);
    if (context.bill.status !== 'OPEN') throw billPrinted();
    return context;
  }

  /** Loads and prices a bill. */
  async context(client: Client, restaurantId: string, billId: string): Promise<BillContext> {
    const bill = await client.bill.findFirst({
      where: { id: billId, restaurantId },
      include: {
        tableSession: { include: { table: { select: { id: true, label: true } } } },
        discounts: { where: { revokedAt: null }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (bill === null) throw billNotFound();
    const orderFilter =
      bill.tableSessionId !== null
        ? { tableSessionId: bill.tableSessionId }
        : { id: bill.orderId ?? '' };
    const [orderItems, snapshot] = await Promise.all([
      client.orderItem.findMany({
        where: { restaurantId, parentOrderItemId: null, order: orderFilter },
        include: { modifiers: { orderBy: { createdAt: 'asc' } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.settings.snapshot(restaurantId),
    ]);
    const billable = orderItems.filter((item) => isBillable(item.state));
    const taxGroupRows = await client.taxGroup.findMany({
      where: { id: { in: [...new Set(billable.map((item) => item.taxGroupId))] } },
      select: { id: true, name: true, sacCode: true },
    });
    const taxGroups = new Map(
      taxGroupRows.map((group) => [group.id, { name: group.name, sacCode: group.sacCode }]),
    );
    const serviceChargeEnabled = snapshot.get('billing.serviceChargeEnabled');
    const rateBp = snapshot.get('billing.serviceChargeRateBp');
    const settings = {
      priceMode: snapshot.get('billing.priceMode'),
      roundingUnitPaise: snapshot.get('billing.roundingUnitPaise'),
      // Dine-in only: a takeaway guest was not served at the table (PROGRESS decision 43).
      serviceChargeRateBp:
        serviceChargeEnabled && !bill.serviceChargeRemoved && bill.tableSessionId !== null
          ? rateBp
          : null,
      serviceChargeEnabled,
      rateBp,
    };
    const items: BillableItem[] = billable.map((item) => ({
      id: item.id,
      name: item.name,
      variantName: item.variantName,
      modifiers: item.modifiers.map(({ name, quantity }) => ({ name, quantity })),
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      taxGroupId: item.taxGroupId,
      taxRates: item.taxRates,
    }));
    // A discount on an item no longer on the bill (cancelled) takes nothing off.
    const billableIds = new Set(items.map((item) => item.id));
    const discounts = bill.discounts
      .filter((discount) => discount.orderItemId === null || billableIds.has(discount.orderItemId))
      .map((discount) => ({
        id: discount.id,
        orderItemId: discount.orderItemId,
        kind: discount.kind,
        rateBp: discount.rateBp,
        amount: discount.amount,
        reason: discount.reason,
        appliedById: discount.appliedById,
        approvedById: discount.approvedById,
      }));
    const calculated = calculateBill(
      items,
      discounts,
      new Map([...taxGroups].map(([id, group]) => [id, group.name])),
      settings,
    );
    return {
      bill,
      tableId: bill.tableSession?.table.id ?? null,
      tableLabel: bill.tableSession?.table.label ?? null,
      items,
      awaitingApproval: orderItems.filter((item) => item.state === 'PENDING_APPROVAL').length,
      discounts,
      settings,
      taxGroups,
      calculated,
    };
  }

  /** What a discount takes off in this calculation. */
  discountAmount(context: BillContext, discountId: string): number {
    const discount = context.discounts.find((candidate) => candidate.id === discountId);
    if (discount === undefined) return 0;
    const { result } = context.calculated;
    if (discount.orderItemId === null) return result.billDiscountTotal;
    return result.lines.find((line) => line.id === discount.orderItemId)?.itemDiscount ?? 0;
  }

  toView(context: BillContext, invoiceIds: readonly string[] = []): BillView {
    const { bill, calculated, settings } = context;
    const { result } = calculated;
    const itemsById = new Map(context.items.map((item) => [item.id, item]));
    return {
      id: bill.id,
      status: bill.status,
      tableSessionId: bill.tableSessionId,
      orderId: bill.orderId,
      tableLabel: context.tableLabel,
      priceMode: result.priceMode,
      lines: result.lines.map((line) => {
        const item = itemsById.get(line.id);
        return {
          orderItemId: line.id,
          description: item === undefined ? '' : describeItem(item),
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          grossAmount: line.grossAmount,
          itemDiscount: line.itemDiscount,
          billDiscountShare: line.billDiscountShare,
          netAmount: line.netAmount,
          taxGroupId: calculated.groupIdOf.get(line.taxGroupId) ?? line.taxGroupId,
          complimentary: isComplimentary(calculated.itemDiscountOf.get(line.id)),
        };
      }),
      discounts: context.discounts.map((discount) => ({
        id: discount.id,
        orderItemId: discount.orderItemId,
        kind: discount.kind,
        rateBp: discount.rateBp,
        amount: this.discountAmount(context, discount.id),
        reason: discount.reason,
        appliedById: discount.appliedById,
        approvedById: discount.approvedById,
      })),
      serviceCharge: {
        enabled: settings.serviceChargeEnabled,
        removed: bill.serviceChargeRemoved,
        rateBp: settings.rateBp,
        amount: result.serviceCharge,
      },
      subtotal: result.subtotal,
      discountTotal: result.discountTotal,
      taxableValueTotal: result.taxableValueTotal,
      taxLines: result.taxLines.map((line) => ({
        taxGroupId: calculated.groupIdOf.get(line.taxGroupId) ?? line.taxGroupId,
        name: line.taxGroupName,
        source: line.source,
        taxableValue: line.taxableValue,
        components: line.components.map(({ code, rateBp, amount }) => ({ code, rateBp, amount })),
        taxTotal: line.taxTotal,
      })),
      taxTotal: result.taxTotal,
      roundOff: result.roundOff,
      grandTotal: result.grandTotal,
      customer: {
        name: bill.customerName,
        phone: bill.customerPhone,
        phoneConsent: bill.customerPhoneConsent,
        gstin: bill.customerGstin,
      },
      invoiceIds: [...invoiceIds],
      editingInvoiceId: bill.editingInvoiceId,
    };
  }

  private async create(
    tx: TransactionClient,
    principal: Principal,
    target: { tableSessionId?: string; orderId?: string },
  ): Promise<string> {
    const businessDate = await currentBusinessDate(tx, principal.restaurantId);
    const bill = await tx.bill.create({
      data: {
        id: newId(),
        restaurantId: principal.restaurantId,
        businessDate: dbDate(businessDate),
        tableSessionId: target.tableSessionId ?? null,
        orderId: target.orderId ?? null,
      },
    });
    return bill.id;
  }

  /**
   * BILL-005: Owner and Manager may give any discount; a cashier up to their limit, and above it
   * or complimentary with a manager's override token for DISCOUNT_ABOVE_LIMIT. Returns the
   * approver, if one was needed.
   */
  private async approve(
    principal: Principal,
    billId: string,
    rateBp: number,
    overrideToken: string | undefined,
  ): Promise<string | null> {
    const snapshot = await this.settings.snapshot(principal.restaurantId);
    const decision = decideDiscount(principal.role, rateBp, {
      CASHIER: snapshot.get('billing.cashierDiscountLimitBp'),
    });
    if (decision === 'ALLOWED') return null;
    if (decision === 'DENIED') throw authErrors.forbidden();
    if (overrideToken === undefined || overrideToken === '') {
      throw authErrors.overrideRequired('DISCOUNT_ABOVE_LIMIT');
    }
    const override = await this.auth.consumeOverride(
      principal,
      'DISCOUNT_ABOVE_LIMIT',
      overrideToken,
    );
    if (override === null) throw authErrors.overrideInvalid();
    // An approval given for a particular bill is good for that bill only.
    if (override.entityId !== null && override.entityId !== billId) {
      throw authErrors.overrideInvalid();
    }
    return override.approverId;
  }
}
