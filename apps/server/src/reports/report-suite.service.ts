import { Injectable } from '@nestjs/common';
import type {
  CancellationReportResponse,
  DiscountReportResponse,
  ReportRangeQuery,
  ReprintReportResponse,
  SourceSalesResponse,
  StaffPerformanceResponse,
} from '@rp/contracts';
import { BASIS_POINTS_PER_WHOLE } from '@rp/domain';
import { isoDateOf } from '../common/business-dates.js';
import { PrismaService } from '../database/prisma.service.js';

type StaffRef = { id: string; name: string } | null;
type OrderSource = SourceSalesResponse['rows'][number]['source'];
type OrderType = SourceSalesResponse['rows'][number]['orderType'];
type OrderItemState = NonNullable<CancellationReportResponse['items'][number]['stage']>;

/** States after the kitchen started: a void from one of them is wastage (RPT-008). */
const COOKED: ReadonlySet<string> = new Set(['PREPARING', 'READY', 'PICKED_UP', 'SERVED']);

/** A count or sum PostgreSQL returns as bigint or numeric, as a number. */
function num(value: bigint | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number(value);
}

function jsonField(json: unknown, field: string): unknown {
  return typeof json === 'object' && json !== null
    ? (json as Record<string, unknown>)[field]
    : undefined;
}

function intField(json: unknown, field: string): number | null {
  const value = jsonField(json, field);
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/**
 * The full report suite, part one (P4-05a): sources and order types (RPT-004), each person's work
 * (RPT-003), discounts and complimentary items (RPT-007), cancellations and voids (RPT-008), and
 * reprints and bill edits (RPT-009). Each is aggregated in PostgreSQL, so a year at design
 * capacity stays within RPT-018's five seconds. Money comes from issued invoices that are not
 * voided, at their current version; who, approver and reason come from the audit trail.
 */
@Injectable()
export class ReportSuiteService {
  constructor(private readonly prisma: PrismaService) {}

  /** RPT-004: billed sales by order source and order type. */
  async sources(restaurantId: string, range: ReportRangeQuery): Promise<SourceSalesResponse> {
    const rows = await this.prisma.$queryRaw<
      {
        source: OrderSource;
        order_type: OrderType;
        orders: bigint;
        gross: bigint;
        discounts: bigint;
        net: bigint;
      }[]
    >`
      SELECT o.source::text AS source, o.order_type::text AS order_type,
             count(DISTINCT o.id) AS orders,
             coalesce(sum(il.line_total), 0) AS gross,
             coalesce(sum(il.discount), 0) AS discounts,
             coalesce(sum(il.taxable_value), 0) AS net
      FROM invoices i
      JOIN invoice_lines il ON il.invoice_id = i.id AND il.version = i.version
      JOIN order_items oi ON oi.id = il.order_item_id
      JOIN orders o ON o.id = oi.order_id
      WHERE i.restaurant_id = ${restaurantId}::uuid
        AND i.status <> 'VOIDED'
        AND i.business_date BETWEEN ${range.from}::date AND ${range.to}::date
      GROUP BY 1, 2
      ORDER BY 1, 2`;
    const mapped = rows.map((row) => ({
      source: row.source,
      orderType: row.order_type,
      orders: num(row.orders),
      gross: num(row.gross),
      discounts: num(row.discounts),
      net: num(row.net),
    }));
    return {
      ...range,
      rows: mapped,
      totals: mapped.reduce(
        (sum, row) => ({
          orders: sum.orders + row.orders,
          gross: sum.gross + row.gross,
          discounts: sum.discounts + row.discounts,
          net: sum.net + row.net,
        }),
        { orders: 0, gross: 0, discounts: 0, net: 0 },
      ),
    };
  }

  /** RPT-003: each person's orders, approvals, sales, acknowledgements, escalations and voids. */
  async staff(restaurantId: string, range: ReportRangeQuery): Promise<StaffPerformanceResponse> {
    const { from, to } = range;
    const [created, approved, sales, acks, escalations, endings] = await Promise.all([
      this.prisma.$queryRaw<{ staff_id: string; n: bigint }[]>`
        SELECT created_by_id AS staff_id, count(*) AS n FROM orders
        WHERE restaurant_id = ${restaurantId}::uuid AND created_by_id IS NOT NULL
          AND business_date BETWEEN ${from}::date AND ${to}::date
        GROUP BY 1`,
      this.prisma.$queryRaw<{ staff_id: string; n: bigint }[]>`
        SELECT approved_by_id AS staff_id, count(DISTINCT order_id) AS n FROM order_items
        WHERE restaurant_id = ${restaurantId}::uuid AND approved_by_id IS NOT NULL
          AND business_date BETWEEN ${from}::date AND ${to}::date
        GROUP BY 1`,
      this.prisma.$queryRaw<{ staff_id: string; net: bigint }[]>`
        SELECT coalesce(oi.created_by_id, oi.approved_by_id) AS staff_id,
               coalesce(sum(il.taxable_value), 0) AS net
        FROM invoices i
        JOIN invoice_lines il ON il.invoice_id = i.id AND il.version = i.version
        JOIN order_items oi ON oi.id = il.order_item_id
        WHERE i.restaurant_id = ${restaurantId}::uuid AND i.status <> 'VOIDED'
          AND i.business_date BETWEEN ${from}::date AND ${to}::date
          AND coalesce(oi.created_by_id, oi.approved_by_id) IS NOT NULL
        GROUP BY 1`,
      this.prisma.$queryRaw<{ staff_id: string; n: bigint; seconds: number | null }[]>`
        SELECT staff_id, count(*) AS n, avg(seconds)::float8 AS seconds FROM (
          SELECT acknowledged_by_id AS staff_id,
                 extract(epoch FROM acknowledged_at - created_at) AS seconds
          FROM alerts
          WHERE restaurant_id = ${restaurantId}::uuid AND acknowledged_by_id IS NOT NULL
            AND acknowledged_at IS NOT NULL
            AND business_date BETWEEN ${from}::date AND ${to}::date
          UNION ALL
          SELECT acknowledged_by_id, extract(epoch FROM acknowledged_at - created_at)
          FROM service_requests
          WHERE restaurant_id = ${restaurantId}::uuid AND acknowledged_by_id IS NOT NULL
            AND acknowledged_at IS NOT NULL
            AND business_date BETWEEN ${from}::date AND ${to}::date
        ) acks
        GROUP BY 1`,
      // Who an alert went to before it escalated (the managers it escalated to are added later).
      this.prisma.$queryRaw<{ staff_id: string; n: bigint }[]>`
        SELECT recipient AS staff_id, count(*) AS n
        FROM alerts, unnest(recipient_ids) AS recipient
        WHERE restaurant_id = ${restaurantId}::uuid AND escalated_at IS NOT NULL
          AND NOT (recipient = ANY (escalated_to))
          AND business_date BETWEEN ${from}::date AND ${to}::date
        GROUP BY 1`,
      this.prisma.$queryRaw<{ staff_id: string; cancelled: bigint; voided: bigint }[]>`
        SELECT actor_id AS staff_id,
               count(*) FILTER (WHERE action = 'ORDER_ITEM_CANCELLED') AS cancelled,
               count(*) FILTER (WHERE action = 'ORDER_ITEM_VOIDED') AS voided
        FROM audit_log
        WHERE restaurant_id = ${restaurantId}::uuid AND actor_id IS NOT NULL
          AND action IN ('ORDER_ITEM_CANCELLED', 'ORDER_ITEM_VOIDED')
          AND business_date BETWEEN ${from}::date AND ${to}::date
        GROUP BY 1`,
    ]);
    const ids = new Set(
      [...created, ...approved, ...sales, ...acks, ...escalations, ...endings].map(
        (row) => row.staff_id,
      ),
    );
    const people = await this.prisma.staff.findMany({
      where: { restaurantId, id: { in: [...ids] } },
      select: { id: true, displayName: true, role: { select: { baseRole: true } } },
      orderBy: { displayName: 'asc' },
    });
    const count = (rows: readonly { staff_id: string; n: bigint }[], id: string) =>
      num(rows.find((row) => row.staff_id === id)?.n);
    return {
      ...range,
      staff: people.map((person) => {
        const ack = acks.find((row) => row.staff_id === person.id);
        const ending = endings.find((row) => row.staff_id === person.id);
        return {
          staffId: person.id,
          name: person.displayName,
          role: person.role.baseRole,
          ordersCreated: count(created, person.id),
          ordersApproved: count(approved, person.id),
          net: num(sales.find((row) => row.staff_id === person.id)?.net),
          acknowledgements: num(ack?.n),
          averageAckSeconds:
            ack?.seconds === null || ack?.seconds === undefined
              ? null
              : Math.max(0, Math.round(ack.seconds)),
          escalations: count(escalations, person.id),
          cancellations: num(ending?.cancelled),
          voids: num(ending?.voided),
        };
      }),
    };
  }

  /** RPT-007: discounts and complimentary items on bills that count, with who and why. */
  async discounts(restaurantId: string, range: ReportRangeQuery): Promise<DiscountReportResponse> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        business_date: Date;
        invoice_id: string;
        invoice_number: string;
        order_id: string | null;
        item: string | null;
        kind: 'PERCENT' | 'FLAT';
        rate_bp: number | null;
        amount: number;
        reason: string;
        applied_by_id: string;
        approved_by_id: string | null;
      }[]
    >`
      SELECT d.id, i.business_date, i.id AS invoice_id, i.invoice_number,
             coalesce(oi.order_id, i.order_id) AS order_id, oi.name AS item,
             d.kind::text AS kind, d.rate_bp, d.amount, d.reason, d.applied_by_id, d.approved_by_id
      FROM discounts d
      JOIN invoices i ON i.id = d.invoice_id
      LEFT JOIN order_items oi ON oi.id = d.order_item_id
      WHERE d.restaurant_id = ${restaurantId}::uuid AND d.revoked_at IS NULL
        AND i.status <> 'VOIDED'
        AND i.business_date BETWEEN ${range.from}::date AND ${range.to}::date
      ORDER BY i.business_date, i.invoice_number, d.created_at`;
    const names = await this.names(rows.flatMap((row) => [row.applied_by_id, row.approved_by_id]));
    const discounts = rows.map((row) => ({
      discountId: row.id,
      businessDate: isoDateOf(row.business_date),
      invoiceId: row.invoice_id,
      invoiceNumber: row.invoice_number,
      orderId: row.order_id,
      item: row.item,
      complimentary: row.kind === 'PERCENT' && row.rate_bp === BASIS_POINTS_PER_WHOLE,
      kind: row.kind,
      rateBp: row.rate_bp,
      amount: row.amount,
      reason: row.reason,
      appliedBy: names(row.applied_by_id),
      approvedBy: names(row.approved_by_id),
    }));
    const complimentary = discounts.filter((discount) => discount.complimentary);
    return {
      ...range,
      discounts,
      totals: {
        count: discounts.length,
        amount: discounts.reduce((sum, discount) => sum + discount.amount, 0),
        complimentaryCount: complimentary.length,
        complimentaryAmount: complimentary.reduce((sum, discount) => sum + discount.amount, 0),
      },
    };
  }

  /** RPT-008: items cancelled or voided (with their stage) and bills voided. */
  async cancellations(
    restaurantId: string,
    range: ReportRangeQuery,
  ): Promise<CancellationReportResponse> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        occurred_at: Date;
        business_date: Date;
        action: string;
        entity_id: string | null;
        actor_id: string | null;
        approver_id: string | null;
        reason: string | null;
        before: unknown;
        order_id: string | null;
        item: string | null;
        invoice_number: string | null;
      }[]
    >`
      SELECT a.id, a.occurred_at, a.business_date, a.action, a.entity_id, a.actor_id,
             a.approver_id, a.reason, a.before, oi.order_id, oi.name AS item,
             i.invoice_number
      FROM audit_log a
      LEFT JOIN order_items oi ON a.entity_type = 'order_item' AND oi.id = a.entity_id
      LEFT JOIN invoices i ON a.entity_type = 'invoice' AND i.id = a.entity_id
      WHERE a.restaurant_id = ${restaurantId}::uuid
        AND a.action IN ('ORDER_ITEM_CANCELLED', 'ORDER_ITEM_VOIDED', 'INVOICE_VOIDED')
        AND a.business_date BETWEEN ${range.from}::date AND ${range.to}::date
      ORDER BY a.occurred_at, a.chain_seq`;
    const names = await this.names(rows.flatMap((row) => [row.actor_id, row.approver_id]));
    const items: CancellationReportResponse['items'] = [];
    const bills: CancellationReportResponse['bills'] = [];
    for (const row of rows) {
      const common = {
        auditId: row.id,
        at: row.occurred_at.toISOString(),
        businessDate: isoDateOf(row.business_date),
        by: names(row.actor_id),
        approvedBy: names(row.approver_id),
        reason: row.reason,
      };
      if (row.action === 'INVOICE_VOIDED') {
        const number = jsonField(row.before, 'invoiceNumber');
        bills.push({
          ...common,
          invoiceId: row.entity_id,
          invoiceNumber: row.invoice_number ?? (typeof number === 'string' ? number : ''),
          value: Math.max(0, intField(row.before, 'grandTotal') ?? 0),
        });
        continue;
      }
      const state = jsonField(row.before, 'state');
      const stage = typeof state === 'string' ? (state as OrderItemState) : null;
      const kind = row.action === 'ORDER_ITEM_VOIDED' ? 'VOIDED' : 'CANCELLED';
      items.push({
        ...common,
        kind,
        orderId: row.order_id,
        orderItemId: row.entity_id,
        item: row.item ?? '',
        quantity: Math.max(0, intField(row.before, 'quantity') ?? 0),
        stage,
        value: Math.max(0, intField(row.before, 'lineTotal') ?? 0),
        wastage: kind === 'VOIDED' && stage !== null && COOKED.has(stage),
      });
    }
    const sum = (list: readonly { value: number }[]) =>
      list.reduce((total, entry) => total + entry.value, 0);
    const cancelled = items.filter((item) => item.kind === 'CANCELLED');
    const voided = items.filter((item) => item.kind === 'VOIDED');
    return {
      ...range,
      items,
      bills,
      totals: {
        cancelledCount: cancelled.length,
        cancelledValue: sum(cancelled),
        voidedCount: voided.length,
        voidedValue: sum(voided),
        wastageValue: sum(items.filter((item) => item.wastage)),
        billCount: bills.length,
        billValue: sum(bills),
      },
    };
  }

  /** RPT-009: kitchen tickets and bills printed again, and bills edited after printing. */
  async reprints(restaurantId: string, range: ReportRangeQuery): Promise<ReprintReportResponse> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        occurred_at: Date;
        business_date: Date;
        action: string;
        entity_id: string | null;
        actor_id: string | null;
        approver_id: string | null;
        reason: string | null;
        before: unknown;
        after: unknown;
        kot_number: number | null;
        kot_order_id: string | null;
        invoice_number: string | null;
        invoice_order_id: string | null;
      }[]
    >`
      SELECT a.id, a.occurred_at, a.business_date, a.action, a.entity_id, a.actor_id,
             a.approver_id, a.reason, a.before, a.after,
             k.kot_number, k.order_id AS kot_order_id,
             i.invoice_number, i.order_id AS invoice_order_id
      FROM audit_log a
      LEFT JOIN kots k ON a.entity_type = 'kot' AND k.id = a.entity_id
      LEFT JOIN invoices i ON a.entity_type = 'invoice' AND i.id = a.entity_id
      WHERE a.restaurant_id = ${restaurantId}::uuid
        AND a.action IN ('KOT_REPRINTED', 'INVOICE_REPRINTED', 'INVOICE_EDITED')
        AND a.business_date BETWEEN ${range.from}::date AND ${range.to}::date
      ORDER BY a.occurred_at, a.chain_seq`;
    const names = await this.names(rows.flatMap((row) => [row.actor_id, row.approver_id]));
    const events = rows.map((row) => {
      const kind =
        row.action === 'KOT_REPRINTED'
          ? ('KOT_REPRINT' as const)
          : row.action === 'INVOICE_REPRINTED'
            ? ('BILL_REPRINT' as const)
            : ('BILL_EDIT' as const);
      const kotNumber = row.kot_number ?? intField(row.after, 'kotNumber');
      return {
        auditId: row.id,
        at: row.occurred_at.toISOString(),
        businessDate: isoDateOf(row.business_date),
        kind,
        reference:
          kind === 'KOT_REPRINT'
            ? `KOT ${kotNumber === null ? '' : String(kotNumber)}`.trim()
            : (row.invoice_number ?? ''),
        orderId: kind === 'KOT_REPRINT' ? row.kot_order_id : row.invoice_order_id,
        invoiceId: kind === 'KOT_REPRINT' ? null : row.entity_id,
        by: names(row.actor_id),
        approvedBy: names(row.approver_id),
        reason: row.reason,
        before: kind === 'BILL_EDIT' ? intField(row.before, 'grandTotal') : null,
        after: kind === 'BILL_EDIT' ? intField(row.after, 'grandTotal') : null,
      };
    });
    return {
      ...range,
      events,
      totals: {
        kotReprints: events.filter((event) => event.kind === 'KOT_REPRINT').length,
        billReprints: events.filter((event) => event.kind === 'BILL_REPRINT').length,
        billEdits: events.filter((event) => event.kind === 'BILL_EDIT').length,
      },
    };
  }

  /** Names for the people a report mentions, read once. */
  private async names(ids: readonly (string | null)[]): Promise<(id: string | null) => StaffRef> {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    const people =
      wanted.length === 0
        ? []
        : await this.prisma.staff.findMany({
            where: { id: { in: wanted } },
            select: { id: true, displayName: true },
          });
    const byId = new Map(people.map((person) => [person.id, person.displayName]));
    return (id) => {
      if (id === null) return null;
      const name = byId.get(id);
      return name === undefined ? null : { id, name };
    };
  }
}
