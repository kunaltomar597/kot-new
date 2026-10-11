import { Injectable } from '@nestjs/common';
import {
  APPROVAL_TARGET_SECONDS,
  type ApprovalTimeReportResponse,
  type CancellationReportResponse,
  type DiscountReportResponse,
  type KitchenReportResponse,
  type RecommendationReportResponse,
  type ReportRangeQuery,
  type ReprintReportResponse,
  type SourceSalesResponse,
  type StaffPerformanceResponse,
  type TableReportResponse,
} from '@rp/contracts';
import { BASIS_POINTS_PER_WHOLE, divideRounded } from '@rp/domain';
import { isoDateOf } from '../common/business-dates.js';
import { PrismaService } from '../database/prisma.service.js';

type StaffRef = { id: string; name: string } | null;
type OrderSource = SourceSalesResponse['rows'][number]['source'];
type OrderType = SourceSalesResponse['rows'][number]['orderType'];
type OrderItemState = NonNullable<CancellationReportResponse['items'][number]['stage']>;
type Layer = RecommendationReportResponse['layers'][number]['layer'];

/** Whole seconds of a sum over a count, or null without any. */
function average(totalSeconds: number, count: number): number | null {
  return count === 0 ? null : Math.max(0, Math.round(totalSeconds / count));
}

/** `part` of `whole` in basis points, or null when there is no whole. */
function shareBp(part: number, whole: number): number | null {
  return whole === 0 ? null : divideRounded(part * BASIS_POINTS_PER_WHOLE, whole);
}

/** Kitchen figures as PostgreSQL gives them: sums of seconds and their counts. */
interface KitchenRow {
  lines: bigint;
  quantity: bigint | null;
  prep_sum: number | null;
  prep_count: bigint;
  pickup_sum: number | null;
  pickup_count: bigint;
}

function kitchenTimes(row: KitchenRow | undefined) {
  return {
    lines: num(row?.lines),
    quantity: num(row?.quantity),
    averagePrepSeconds: average(row?.prep_sum ?? 0, num(row?.prep_count)),
    averagePickupSeconds: average(row?.pickup_sum ?? 0, num(row?.pickup_count)),
  };
}

/** Suggestion counts as PostgreSQL gives them. */
interface SuggestionRow {
  impressions: bigint;
  taps: bigint;
  added: bigint;
  ordered: bigint;
  revenue: bigint;
}

function suggestionFigures(row: SuggestionRow | undefined) {
  const impressions = num(row?.impressions);
  const ordered = num(row?.ordered);
  return {
    impressions,
    taps: num(row?.taps),
    addedToCart: num(row?.added),
    ordered,
    attachRateBp: shareBp(ordered, impressions),
    revenue: num(row?.revenue),
  };
}

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
      WITH per_order AS (
        -- Each order's lines summed first: counting distinct orders over every line sorted a
        -- year's 2.9 million lines (P8-01a).
        SELECT oi.order_id,
               sum(il.line_total) AS gross,
               sum(il.discount) AS discounts,
               sum(il.taxable_value) AS net
        FROM invoices i
        JOIN invoice_lines il ON il.invoice_id = i.id AND il.version = i.version
        JOIN order_items oi ON oi.id = il.order_item_id
        WHERE i.restaurant_id = ${restaurantId}::uuid
          AND i.status <> 'VOIDED'
          AND i.business_date BETWEEN ${range.from}::date AND ${range.to}::date
        GROUP BY oi.order_id
      )
      SELECT o.source::text AS source, o.order_type::text AS order_type,
             count(*) AS orders,
             coalesce(sum(p.gross), 0) AS gross,
             coalesce(sum(p.discounts), 0) AS discounts,
             coalesce(sum(p.net), 0) AS net
      FROM per_order p
      JOIN orders o ON o.id = p.order_id
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
             coalesce(oi.order_id, i.order_id, (
               -- A table's bill: its first order, whose drill-down lists the table's bills.
               SELECT o.id FROM orders o WHERE o.table_session_id = i.table_session_id
               ORDER BY o.business_date, o.order_number LIMIT 1
             )) AS order_id, oi.name AS item,
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
             i.invoice_number,
             coalesce(i.order_id, (
               SELECT o.id FROM orders o WHERE o.table_session_id = i.table_session_id
               ORDER BY o.business_date, o.order_number LIMIT 1
             )) AS invoice_order_id
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

  /**
   * Pilot KPI (risk R-04): how long customer orders (tablet and QR) wait for approval, per order,
   * from the customer placing it to the first approval that sent it on; rejected orders are
   * counted and not timed.
   */
  async approvalTimes(
    restaurantId: string,
    range: ReportRangeQuery,
  ): Promise<ApprovalTimeReportResponse> {
    const { from, to } = range;
    const target = APPROVAL_TARGET_SECONDS;
    const rows = await this.prisma.$queryRaw<
      {
        business_date: Date | null;
        orders: bigint;
        median: number | null;
        p95: number | null;
        over: bigint;
      }[]
    >`
      WITH waits AS (
        SELECT o.id, o.business_date,
               extract(epoch FROM min(oi.sent_at) - min(oi.created_at)) AS seconds
        FROM orders o JOIN order_items oi ON oi.order_id = o.id
        WHERE o.restaurant_id = ${restaurantId}::uuid AND o.source IN ('TABLE_TABLET', 'QR')
          AND o.business_date BETWEEN ${from}::date AND ${to}::date
          AND oi.approved_by_id IS NOT NULL AND oi.sent_at IS NOT NULL
        GROUP BY o.id, o.business_date
      )
      SELECT business_date,
             count(*) AS orders,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds)::float8 AS median,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY seconds)::float8 AS p95,
             count(*) FILTER (WHERE seconds > ${target}) AS over
      FROM waits GROUP BY ROLLUP (business_date) ORDER BY business_date`;
    const rejected = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(DISTINCT o.id) AS n
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.restaurant_id = ${restaurantId}::uuid AND o.source IN ('TABLE_TABLET', 'QR')
        AND o.business_date BETWEEN ${from}::date AND ${to}::date
        AND oi.state = 'REJECTED'`;
    const whole = (value: number | null) =>
      value === null ? null : Math.max(0, Math.round(value));
    const figures = (row: (typeof rows)[number]) => ({
      orders: num(row.orders),
      medianSeconds: whole(row.median),
      p95Seconds: whole(row.p95),
      overTarget: num(row.over),
    });
    // ROLLUP adds the grand total as the row without a date.
    const totalRow = rows.find((row) => row.business_date === null);
    const totals = totalRow
      ? figures(totalRow)
      : { orders: 0, medianSeconds: null, p95Seconds: null, overTarget: 0 };
    return {
      ...range,
      targetSeconds: target,
      meetsTarget: totals.medianSeconds === null ? null : totals.medianSeconds <= target,
      rejected: num(rejected[0]?.n),
      days: rows.flatMap((row) =>
        row.business_date === null
          ? []
          : [{ businessDate: isoDateOf(row.business_date), ...figures(row) }],
      ),
      totals,
    };
  }

  /**
   * RPT-010: average prep time (kitchen start, or sending for a dish bumped straight to ready, to
   * ready) and ready-to-pickup time (to picked up, or served), by station and dish; combos are
   * cooked as their parts. "Notify manager" presses are the kitchen's own uncollected-dish alerts.
   */
  async kitchen(restaurantId: string, range: ReportRangeQuery): Promise<KitchenReportResponse> {
    const { from, to } = range;
    // Combos are cooked as their parts; there are few, so they are left out by id.
    const combos = (
      await this.prisma.combo.findMany({ where: { restaurantId }, select: { itemId: true } })
    ).map((combo) => combo.itemId);
    // One pass over the year's lines, by dish and station; stations add up their dishes.
    const cooked = this.prisma.$queryRaw<(KitchenRow & { item_id: string; station_id: string })[]>`
      SELECT oi.item_id, oi.station_id, count(*) AS lines, sum(oi.quantity) AS quantity,
             sum(t.prep) FILTER (WHERE t.prep >= 0)::float8 AS prep_sum,
             count(t.prep) FILTER (WHERE t.prep >= 0) AS prep_count,
             sum(t.pickup) FILTER (WHERE t.pickup >= 0)::float8 AS pickup_sum,
             count(t.pickup) FILTER (WHERE t.pickup >= 0) AS pickup_count
      FROM order_items oi
      CROSS JOIN LATERAL (
        SELECT extract(epoch FROM oi.ready_at - coalesce(oi.preparing_at, oi.sent_at)) AS prep,
               extract(epoch FROM coalesce(oi.picked_up_at, oi.served_at) - oi.ready_at) AS pickup
      ) t
      WHERE oi.restaurant_id = ${restaurantId}::uuid AND oi.ready_at IS NOT NULL
        AND oi.business_date BETWEEN ${from}::date AND ${to}::date
        AND NOT (oi.item_id = ANY (${combos}::uuid[]))
      GROUP BY 1, 2`;
    const presses = this.prisma.$queryRaw<{ station_id: string; n: bigint }[]>`
      SELECT k.station_id, count(*) AS n
      FROM alerts a JOIN kots k ON k.id = a.kot_id
      WHERE a.restaurant_id = ${restaurantId}::uuid AND a.type = 'READY_NOT_COLLECTED'
        AND a.raised_by_device_id IS NOT NULL
        AND a.business_date BETWEEN ${from}::date AND ${to}::date
      GROUP BY 1`;
    const [cookedRows, pressRows, stations] = await Promise.all([
      cooked,
      presses,
      this.prisma.station.findMany({
        where: { restaurantId },
        select: { id: true, name: true, archivedAt: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    const items = await this.prisma.item.findMany({
      where: { id: { in: [...new Set(cookedRows.map((row) => row.item_id))] } },
      select: { id: true, name: true },
    });
    const itemName = new Map(items.map((item) => [item.id, item.name]));
    const stationName = new Map(stations.map((station) => [station.id, station.name]));
    const stationRows = [...new Set(cookedRows.map((row) => row.station_id))].map(
      (stationId): KitchenRow & { station_id: string } => {
        const rows = cookedRows.filter((row) => row.station_id === stationId);
        const total = (field: keyof KitchenRow) =>
          rows.reduce((sum, row) => sum + num(row[field]), 0);
        return {
          station_id: stationId,
          lines: BigInt(total('lines')),
          quantity: BigInt(total('quantity')),
          prep_sum: total('prep_sum'),
          prep_count: BigInt(total('prep_count')),
          pickup_sum: total('pickup_sum'),
          pickup_count: BigInt(total('pickup_count')),
        };
      },
    );
    const used = new Set([...stationRows, ...pressRows].map((row) => row.station_id));
    const shown = stations.filter((station) => station.archivedAt === null || used.has(station.id));
    const pressesOf = (stationId: string) =>
      num(pressRows.find((row) => row.station_id === stationId)?.n);
    const sum = (field: keyof KitchenRow) =>
      stationRows.reduce((total, row) => total + num(row[field]), 0);
    return {
      ...range,
      stations: shown.map((station) => ({
        stationId: station.id,
        name: station.name,
        ...kitchenTimes(stationRows.find((row) => row.station_id === station.id)),
        notifyManager: pressesOf(station.id),
      })),
      items: cookedRows
        .map((row) => ({
          itemId: row.item_id,
          name: itemName.get(row.item_id) ?? '',
          station: stationName.get(row.station_id) ?? '',
          ...kitchenTimes(row),
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'en-IN') || a.itemId.localeCompare(b.itemId)),
      totals: {
        lines: sum('lines'),
        quantity: sum('quantity'),
        averagePrepSeconds: average(sum('prep_sum'), sum('prep_count')),
        averagePickupSeconds: average(sum('pickup_sum'), sum('pickup_count')),
        notifyManager: pressRows.reduce((total, row) => total + num(row.n), 0),
      },
    };
  }

  /**
   * RPT-011: covers, seated time and spend of the tables served (closed sessions, not those closed
   * as opened by mistake), by table; turnover is sessions per table per day.
   */
  async tables(restaurantId: string, range: ReportRangeQuery): Promise<TableReportResponse> {
    const [rows, tableCount] = await Promise.all([
      this.prisma.$queryRaw<
        {
          table_id: string;
          label: string;
          sessions: bigint;
          covers: bigint;
          seated_sum: number | null;
          spend: bigint;
        }[]
      >`
        WITH served AS (
          SELECT id, table_id, coalesce(covers, 0) AS covers,
                 extract(epoch FROM closed_at - opened_at) AS seated
          FROM table_sessions
          WHERE restaurant_id = ${restaurantId}::uuid AND status = 'CLOSED'
            AND close_reason IS NULL AND closed_at IS NOT NULL
            AND business_date BETWEEN ${range.from}::date AND ${range.to}::date
        ), spend AS (
          SELECT i.table_session_id, sum(i.grand_total) AS spend
          FROM invoices i JOIN served s ON s.id = i.table_session_id
          WHERE i.status <> 'VOIDED'
          GROUP BY 1
        )
        SELECT s.table_id, t.label, count(*) AS sessions, sum(s.covers) AS covers,
               sum(greatest(s.seated, 0))::float8 AS seated_sum,
               coalesce(sum(sp.spend), 0) AS spend
        FROM served s
        JOIN tables t ON t.id = s.table_id
        LEFT JOIN spend sp ON sp.table_session_id = s.id
        GROUP BY 1, 2
        ORDER BY 2`,
      this.prisma.diningTable.count({ where: { restaurantId, archivedAt: null } }),
    ]);
    const figures = (sessions: number, covers: number, seated: number, spend: number) => ({
      sessions,
      covers,
      averageSeatedSeconds: average(seated, sessions),
      spend,
      spendPerCover: covers === 0 ? null : divideRounded(spend, covers),
    });
    const tables = rows.map((row) => ({
      tableId: row.table_id,
      label: row.label,
      ...figures(num(row.sessions), num(row.covers), row.seated_sum ?? 0, num(row.spend)),
    }));
    const total = (pick: (row: (typeof rows)[number]) => bigint | number | null) =>
      rows.reduce((sum, row) => sum + num(pick(row)), 0);
    const sessions = total((row) => row.sessions);
    const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1;
    return {
      ...range,
      tables,
      totals: {
        ...figures(
          sessions,
          total((row) => row.covers),
          total((row) => row.seated_sum),
          total((row) => row.spend),
        ),
        tableCount,
        days,
        turnoverBp: shareBp(sessions, tableCount * days) ?? 0,
      },
    };
  }

  /**
   * RPT-012 (REC-008): suggestions shown, opened, added to a cart and ordered, per layer and dish.
   * Revenue is the line total of suggested lines that were not rejected, cancelled or voided. The
   * events are counted on their own; only the ordered ones are joined to their lines (most events
   * have no line, and joining them all on it is what made a year slow).
   */
  async recommendations(
    restaurantId: string,
    range: ReportRangeQuery,
  ): Promise<RecommendationReportResponse> {
    const { from, to } = range;
    const [countRows, revenueRows, orderRow] = await Promise.all([
      this.prisma.$queryRaw<
        {
          layer: Layer;
          item_id: string;
          impressions: bigint;
          taps: bigint;
          added: bigint;
          ordered: bigint;
        }[]
      >`
        SELECT layer::text AS layer, item_id,
               count(*) FILTER (WHERE kind = 'IMPRESSION') AS impressions,
               count(*) FILTER (WHERE kind = 'TAP') AS taps,
               count(*) FILTER (WHERE kind = 'ADD_TO_CART') AS added,
               count(*) FILTER (WHERE kind = 'ORDERED') AS ordered
        FROM recommendation_events
        WHERE restaurant_id = ${restaurantId}::uuid
          AND business_date BETWEEN ${from}::date AND ${to}::date
        GROUP BY 1, 2`,
      // Per layer and dish, plus one row for all of them (both columns null) with the orders.
      this.prisma.$queryRaw<
        { layer: Layer | null; item_id: string | null; revenue: bigint; orders: bigint }[]
      >`
        SELECT e.layer::text AS layer, e.item_id, sum(oi.line_total) AS revenue,
               count(DISTINCT oi.order_id) AS orders
        FROM recommendation_events e JOIN order_items oi ON oi.id = e.order_item_id
        WHERE e.restaurant_id = ${restaurantId}::uuid AND e.kind = 'ORDERED'
          AND e.business_date BETWEEN ${from}::date AND ${to}::date
          AND oi.state NOT IN ('REJECTED', 'CANCELLED', 'VOIDED')
        GROUP BY GROUPING SETS ((1, 2), ())`,
      this.prisma.$queryRaw<{ orders: bigint }[]>`
        SELECT count(*) AS orders FROM orders
        WHERE restaurant_id = ${restaurantId}::uuid
          AND business_date BETWEEN ${from}::date AND ${to}::date`,
    ]);
    const revenueOf = (match: (row: (typeof revenueRows)[number]) => boolean) =>
      revenueRows
        .filter((row) => row.item_id !== null && match(row))
        .reduce((sum, row) => sum + row.revenue, 0n);
    const sumOf = (rows: readonly (typeof countRows)[number][]): Omit<SuggestionRow, 'revenue'> =>
      rows.reduce(
        (sum, row) => ({
          impressions: sum.impressions + row.impressions,
          taps: sum.taps + row.taps,
          added: sum.added + row.added,
          ordered: sum.ordered + row.ordered,
        }),
        { impressions: 0n, taps: 0n, added: 0n, ordered: 0n },
      );
    const layers = (['RULE', 'LEARNED', 'BEST_SELLER'] as const satisfies readonly Layer[]).map(
      (layer) => ({
        layer,
        ...suggestionFigures({
          ...sumOf(countRows.filter((row) => row.layer === layer)),
          revenue: revenueOf((row) => row.layer === layer),
        }),
      }),
    );
    const itemIds = [...new Set(countRows.map((row) => row.item_id))];
    const names = new Map(
      (
        await this.prisma.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, name: true },
        })
      ).map((item) => [item.id, item.name]),
    );
    const items = itemIds
      .map((itemId) => ({
        itemId,
        name: names.get(itemId) ?? '',
        ...suggestionFigures({
          ...sumOf(countRows.filter((row) => row.item_id === itemId)),
          revenue: revenueOf((row) => row.item_id === itemId),
        }),
      }))
      .sort(
        (a, b) =>
          b.ordered - a.ordered || b.revenue - a.revenue || a.name.localeCompare(b.name, 'en-IN'),
      );
    const overall = revenueRows.find((row) => row.layer === null && row.item_id === null);
    return {
      ...range,
      layers,
      items,
      totals: {
        ...suggestionFigures({ ...sumOf(countRows), revenue: overall?.revenue ?? 0n }),
        orders: num(orderRow[0]?.orders),
        ordersWithSuggestion: num(overall?.orders),
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
