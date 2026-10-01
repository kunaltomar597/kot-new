import { Injectable } from '@nestjs/common';
import {
  type ReportRangeQuery,
  SUSPICIOUS_KINDS,
  type SuspiciousActivityResponse,
  type SuspiciousFlag,
  type SuspiciousKind,
} from '@rp/contracts';
import { BASIS_POINTS_PER_WHOLE, divideRounded } from '@rp/domain';
import { currentBusinessDate, isoDateOf } from '../common/business-dates.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { SettingsService } from '../settings/settings.service.js';

interface StaffRef {
  id: string;
  name: string;
}
type Names = (id: string | null) => StaffRef | null;

/** A flag before the names of its people are known. */
type Draft = Omit<SuspiciousFlag, 'by' | 'approvedBy' | 'alsoBy'> & {
  byId: string | null;
  approvedById: string | null;
  alsoByIds?: readonly string[];
};

/** States after the kitchen started: a void from one of them threw cooked food away. */
const COOKED = ['PREPARING', 'READY', 'PICKED_UP', 'SERVED'];

/** A count or sum PostgreSQL returns as bigint or numeric, as a number. */
function num(value: bigint | number | null | undefined): number {
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

/** A flag's fields that most patterns leave empty. */
const EMPTY = {
  approvedById: null,
  reason: null,
  orderId: null,
  invoiceId: null,
  invoiceNumber: null,
  kotNumber: null,
  item: null,
  quantity: null,
  amount: null,
  rateBp: null,
  count: null,
} as const;

/**
 * The order of invoice `i`: a table's bill gives its first order, whose drill-down lists the
 * table's bills (as RPT-007 does).
 */
const INVOICE_ORDER = Prisma.sql`coalesce(i.order_id, (
  SELECT o.id FROM orders o WHERE o.table_session_id = i.table_session_id
  ORDER BY o.business_date, o.order_number LIMIT 1
))`;

/**
 * The suspicious-activity report (P4-07b, RPT-014, AUD-006): the patterns AUD-006 names, each
 * flag with the person it is about, read from the audit trail, the bills and the shifts. The
 * thresholds are settings (`audit.discountFlagBp`, `audit.cashVarianceFlagPaise`,
 * `audit.reprintFlagCount`). Every query reads by restaurant and business date through an index,
 * so a year stays within RPT-018's five seconds and one day is instant for the daily job.
 */
@Injectable()
export class SuspiciousActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async report(restaurantId: string, range: ReportRangeQuery): Promise<SuspiciousActivityResponse> {
    const snapshot = await this.settings.snapshot(restaurantId);
    const thresholds = {
      discountFlagBp: snapshot.get('audit.discountFlagBp'),
      cashVarianceFlagPaise: snapshot.get('audit.cashVarianceFlagPaise'),
      reprintFlagCount: snapshot.get('audit.reprintFlagCount'),
    };
    const today = await currentBusinessDate(this.prisma, restaurantId);
    // One query after another: in parallel they would hold most of the pool for the whole report.
    const drafts: Draft[] = [];
    for (const patterns of [
      () => this.voidsAfterPrint(restaurantId, range),
      () => this.editsAfterPrint(restaurantId, range),
      () => this.bigDiscounts(restaurantId, range, thresholds.discountFlagBp),
      () => this.repeatedReprints(restaurantId, range, thresholds.reprintFlagCount),
      () => this.cashVariances(restaurantId, range, thresholds.cashVarianceFlagPaise),
      () => this.cookedVoids(restaurantId, range),
      () => this.sentNotBilled(restaurantId, range, today),
      () => this.noSaleOpenings(restaurantId, range),
    ]) {
      drafts.push(...(await patterns()));
    }
    const names = await this.names(
      drafts.flatMap((draft) => [draft.byId, draft.approvedById, ...(draft.alsoByIds ?? [])]),
    );
    const order = new Map(SUSPICIOUS_KINDS.map((kind, index) => [kind, index]));
    const flags = drafts
      .map(({ byId, approvedById, alsoByIds, ...flag }) => ({
        ...flag,
        by: names(byId),
        approvedBy: names(approvedById),
        alsoBy: (alsoByIds ?? []).flatMap((id) => names(id) ?? []),
      }))
      .sort(
        (a, b) =>
          (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0) ||
          a.at.localeCompare(b.at) ||
          a.flagId.localeCompare(b.flagId),
      );
    const perKind = new Map<SuspiciousKind, number>();
    const perPerson = new Map<string, StaffRef & { count: number }>();
    for (const flag of flags) {
      perKind.set(flag.kind, (perKind.get(flag.kind) ?? 0) + 1);
      if (flag.by !== null) {
        const seen = perPerson.get(flag.by.id) ?? { ...flag.by, count: 0 };
        perPerson.set(flag.by.id, { ...seen, count: seen.count + 1 });
      }
    }
    return {
      ...range,
      thresholds,
      flags,
      totals: SUSPICIOUS_KINDS.map((kind) => ({ kind, count: perKind.get(kind) ?? 0 })),
      people: [...perPerson.values()].sort(
        (a, b) => b.count - a.count || a.name.localeCompare(b.name),
      ),
    };
  }

  /** Printed bills voided, and items cancelled or voided after their bill was printed. */
  private async voidsAfterPrint(restaurantId: string, range: ReportRangeQuery): Promise<Draft[]> {
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
        invoice_number: string | null;
        invoice_order_id: string | null;
        item: string | null;
        item_order_id: string | null;
        printed_invoice_id: string | null;
        printed_invoice_number: string | null;
      }[]
    >`
      SELECT a.id, a.occurred_at, a.business_date, a.action, a.entity_id, a.actor_id,
             a.approver_id, a.reason, a.before,
             i.invoice_number, ${INVOICE_ORDER} AS invoice_order_id,
             oi.name AS item, oi.order_id AS item_order_id,
             printed.id AS printed_invoice_id, printed.invoice_number AS printed_invoice_number
      FROM audit_log a
      LEFT JOIN invoices i ON a.entity_type = 'invoice' AND i.id = a.entity_id
      LEFT JOIN order_items oi ON a.entity_type = 'order_item' AND oi.id = a.entity_id
      LEFT JOIN LATERAL (
        -- The bill the item was on, printed before the item was taken off it.
        SELECT pi.id, pi.invoice_number
        FROM invoice_lines il
        JOIN invoices pi ON pi.id = il.invoice_id
        WHERE oi.id IS NOT NULL AND il.order_item_id = oi.id
          AND EXISTS (
            SELECT 1 FROM audit_log p
            WHERE p.entity_type = 'invoice' AND p.entity_id = pi.id
              AND p.action = 'INVOICE_PRINTED' AND p.occurred_at < a.occurred_at
          )
        ORDER BY pi.issued_at DESC
        LIMIT 1
      ) printed ON true
      WHERE a.restaurant_id = ${restaurantId}::uuid
        AND a.action IN ('INVOICE_VOIDED', 'ORDER_ITEM_CANCELLED', 'ORDER_ITEM_VOIDED')
        AND a.business_date BETWEEN ${range.from}::date AND ${range.to}::date
        AND (
          -- An edited bill prints as an original again, so its audit trail says it was printed.
          (a.action = 'INVOICE_VOIDED' AND EXISTS (
            SELECT 1 FROM audit_log p
            WHERE p.entity_type = 'invoice' AND p.entity_id = a.entity_id
              AND p.action = 'INVOICE_PRINTED' AND p.occurred_at < a.occurred_at
          ))
          OR printed.id IS NOT NULL
        )`;
    return rows.map((row) => {
      const common = {
        ...EMPTY,
        flagId: `VOID_AFTER_PRINT:${row.id}`,
        kind: 'VOID_AFTER_PRINT' as const,
        at: row.occurred_at.toISOString(),
        businessDate: isoDateOf(row.business_date),
        byId: row.actor_id,
        approvedById: row.approver_id,
        reason: row.reason,
      };
      if (row.action === 'INVOICE_VOIDED') {
        const number = jsonField(row.before, 'invoiceNumber');
        return {
          ...common,
          orderId: row.invoice_order_id,
          invoiceId: row.entity_id,
          invoiceNumber: row.invoice_number ?? (typeof number === 'string' ? number : null),
          amount: Math.max(0, intField(row.before, 'grandTotal') ?? 0),
        };
      }
      return {
        ...common,
        orderId: row.item_order_id,
        invoiceId: row.printed_invoice_id,
        invoiceNumber: row.printed_invoice_number,
        item: row.item,
        quantity: Math.max(0, intField(row.before, 'quantity') ?? 0),
        amount: Math.max(0, intField(row.before, 'lineTotal') ?? 0),
      };
    });
  }

  /** Printed bills edited under their number (BILL-010), with the change in the total. */
  private async editsAfterPrint(restaurantId: string, range: ReportRangeQuery): Promise<Draft[]> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        occurred_at: Date;
        business_date: Date;
        entity_id: string | null;
        actor_id: string | null;
        approver_id: string | null;
        reason: string | null;
        before: unknown;
        after: unknown;
        invoice_number: string | null;
        invoice_order_id: string | null;
      }[]
    >`
      SELECT a.id, a.occurred_at, a.business_date, a.entity_id, a.actor_id, a.approver_id,
             a.reason, a.before, a.after, i.invoice_number,
             ${INVOICE_ORDER} AS invoice_order_id
      FROM audit_log a
      JOIN invoices i ON i.id = a.entity_id
      WHERE a.restaurant_id = ${restaurantId}::uuid AND a.action = 'INVOICE_EDITED'
        AND a.entity_type = 'invoice'
        AND a.business_date BETWEEN ${range.from}::date AND ${range.to}::date
        AND EXISTS (
          SELECT 1 FROM audit_log p
          WHERE p.entity_type = 'invoice' AND p.entity_id = a.entity_id
            AND p.action = 'INVOICE_PRINTED' AND p.occurred_at < a.occurred_at
        )`;
    return rows.map((row) => {
      const before = intField(row.before, 'grandTotal');
      const after = intField(row.after, 'grandTotal');
      return {
        ...EMPTY,
        flagId: `EDIT_AFTER_PRINT:${row.id}`,
        kind: 'EDIT_AFTER_PRINT',
        at: row.occurred_at.toISOString(),
        businessDate: isoDateOf(row.business_date),
        byId: row.actor_id,
        approvedById: row.approver_id,
        reason: row.reason,
        orderId: row.invoice_order_id,
        invoiceId: row.entity_id,
        invoiceNumber: row.invoice_number,
        amount: before === null || after === null ? null : after - before,
      };
    });
  }

  /**
   * Discounts above the threshold on bills that count (as RPT-007 lists them). A flat discount's
   * rate is of what it applied to: the item's line, or the bill after item discounts, rounded up
   * as the discount limits are.
   */
  private async bigDiscounts(
    restaurantId: string,
    range: ReportRangeQuery,
    thresholdBp: number,
  ): Promise<Draft[]> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        created_at: Date;
        business_date: Date;
        invoice_id: string;
        invoice_number: string;
        order_id: string | null;
        item: string | null;
        quantity: number | null;
        kind: 'PERCENT' | 'FLAT';
        rate_bp: number | null;
        amount: number;
        base: number;
        reason: string;
        applied_by_id: string;
        approved_by_id: string | null;
      }[]
    >`
      SELECT d.id, d.created_at, i.business_date, i.id AS invoice_id, i.invoice_number,
             coalesce(oi.order_id, ${INVOICE_ORDER}) AS order_id,
             oi.name AS item, oi.quantity, d.kind::text AS kind, d.rate_bp, d.amount,
             CASE WHEN d.order_item_id IS NULL THEN i.subtotal - i.discount_total + d.amount
                  ELSE oi.line_total END AS base,
             d.reason, d.applied_by_id, d.approved_by_id
      FROM discounts d
      JOIN invoices i ON i.id = d.invoice_id
      LEFT JOIN order_items oi ON oi.id = d.order_item_id
      WHERE d.restaurant_id = ${restaurantId}::uuid AND d.revoked_at IS NULL
        AND i.status <> 'VOIDED'
        AND i.business_date BETWEEN ${range.from}::date AND ${range.to}::date`;
    return rows.flatMap((row) => {
      const rateBp =
        row.kind === 'PERCENT' && row.rate_bp !== null
          ? row.rate_bp
          : row.base <= 0
            ? BASIS_POINTS_PER_WHOLE
            : Math.min(
                BASIS_POINTS_PER_WHOLE,
                divideRounded(row.amount * BASIS_POINTS_PER_WHOLE, row.base, 'UP'),
              );
      if (rateBp <= thresholdBp) return [];
      return [
        {
          ...EMPTY,
          flagId: `DISCOUNT_OVER_LIMIT:${row.id}`,
          kind: 'DISCOUNT_OVER_LIMIT' as const,
          at: row.created_at.toISOString(),
          businessDate: isoDateOf(row.business_date),
          byId: row.applied_by_id,
          approvedById: row.approved_by_id,
          reason: row.reason,
          orderId: row.order_id,
          invoiceId: row.invoice_id,
          invoiceNumber: row.invoice_number,
          item: row.item,
          quantity: row.quantity,
          amount: row.amount,
          rateBp,
        },
      ];
    });
  }

  /**
   * Kitchen tickets and bills printed again `threshold` times or more in the range. The flag is
   * about whoever reprinted it most (the latest of them on a tie); the others are listed with it.
   */
  private async repeatedReprints(
    restaurantId: string,
    range: ReportRangeQuery,
    threshold: number,
  ): Promise<Draft[]> {
    const rows = await this.prisma.$queryRaw<
      {
        entity_type: string;
        entity_id: string;
        actor_id: string | null;
        n: bigint;
        last_at: Date;
        business_date: Date;
        last_reason: string | null;
      }[]
    >`
      SELECT a.entity_type, a.entity_id, a.actor_id, count(*) AS n, max(a.occurred_at) AS last_at,
             max(a.business_date) AS business_date,
             (array_agg(a.reason ORDER BY a.occurred_at DESC))[1] AS last_reason
      FROM audit_log a
      WHERE a.restaurant_id = ${restaurantId}::uuid
        AND a.action IN ('KOT_REPRINTED', 'INVOICE_REPRINTED')
        AND a.business_date BETWEEN ${range.from}::date AND ${range.to}::date
        AND a.entity_id IS NOT NULL
      GROUP BY a.entity_type, a.entity_id, a.actor_id`;
    const documents = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.entity_type}:${row.entity_id}`;
      documents.set(key, [...(documents.get(key) ?? []), row]);
    }
    const repeated = [...documents.values()].filter(
      (people) => people.reduce((total, person) => total + num(person.n), 0) >= threshold,
    );
    if (repeated.length === 0) return [];
    const kotIds = repeated.flatMap((people) =>
      people[0]?.entity_type === 'kot' ? [people[0].entity_id] : [],
    );
    const invoiceIds = repeated.flatMap((people) =>
      people[0]?.entity_type === 'invoice' ? [people[0].entity_id] : [],
    );
    const kots = await this.prisma.kot.findMany({
      where: { id: { in: kotIds } },
      select: { id: true, kotNumber: true, orderId: true },
    });
    const invoices = await this.prisma.$queryRaw<
      { id: string; invoice_number: string; order_id: string | null }[]
    >`
      SELECT i.id, i.invoice_number, ${INVOICE_ORDER} AS order_id
      FROM invoices i WHERE i.id = ANY(${invoiceIds}::uuid[])`;
    const kotById = new Map(kots.map((kot) => [kot.id, kot]));
    const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
    return repeated.flatMap((people) => {
      const ranked = [...people].sort(
        (a, b) => num(b.n) - num(a.n) || b.last_at.getTime() - a.last_at.getTime(),
      );
      const [first] = ranked;
      if (first === undefined) return [];
      const latest = people.reduce((last, row) => (row.last_at > last.last_at ? row : last));
      const kot = first.entity_type === 'kot' ? kotById.get(first.entity_id) : undefined;
      const invoice =
        first.entity_type === 'invoice' ? invoiceById.get(first.entity_id) : undefined;
      return [
        {
          ...EMPTY,
          flagId: `REPEATED_REPRINT:${first.entity_type}:${first.entity_id}`,
          kind: 'REPEATED_REPRINT' as const,
          at: latest.last_at.toISOString(),
          businessDate: isoDateOf(latest.business_date),
          byId: first.actor_id,
          alsoByIds: ranked
            .slice(1)
            .flatMap((row) => (row.actor_id === null ? [] : [row.actor_id])),
          reason: latest.last_reason,
          orderId: kot?.orderId ?? invoice?.order_id ?? null,
          invoiceId: invoice?.id ?? null,
          invoiceNumber: invoice?.invoice_number ?? null,
          kotNumber: kot?.kotNumber ?? null,
          count: people.reduce((total, person) => total + num(person.n), 0),
        },
      ];
    });
  }

  /** Shifts closed more than the threshold over or short. */
  private async cashVariances(
    restaurantId: string,
    range: ReportRangeQuery,
    thresholdPaise: number,
  ): Promise<Draft[]> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        business_date: Date;
        closed_at: Date;
        staff_id: string;
        variance: bigint;
        closer_id: string | null;
      }[]
    >`
      SELECT s.id, s.business_date, s.closed_at, s.staff_id, s.variance,
             (SELECT a.actor_id FROM audit_log a
              WHERE a.entity_type = 'shift' AND a.entity_id = s.id AND a.action = 'SHIFT_CLOSED'
              ORDER BY a.occurred_at DESC LIMIT 1) AS closer_id
      FROM shifts s
      WHERE s.restaurant_id = ${restaurantId}::uuid AND s.status = 'CLOSED'
        AND s.business_date BETWEEN ${range.from}::date AND ${range.to}::date
        AND s.closed_at IS NOT NULL AND abs(s.variance) > ${thresholdPaise}`;
    return rows.map((row) => ({
      ...EMPTY,
      flagId: `CASH_VARIANCE:${row.id}`,
      kind: 'CASH_VARIANCE',
      at: row.closed_at.toISOString(),
      businessDate: isoDateOf(row.business_date),
      // The drawer is the shift holder's; a manager who closed it for them is listed too.
      byId: row.staff_id,
      alsoByIds: row.closer_id !== null && row.closer_id !== row.staff_id ? [row.closer_id] : [],
      amount: num(row.variance),
    }));
  }

  /** Items voided after the kitchen started them. */
  private async cookedVoids(restaurantId: string, range: ReportRangeQuery): Promise<Draft[]> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        occurred_at: Date;
        business_date: Date;
        actor_id: string | null;
        approver_id: string | null;
        reason: string | null;
        before: unknown;
        order_id: string | null;
        item: string | null;
      }[]
    >`
      SELECT a.id, a.occurred_at, a.business_date, a.actor_id, a.approver_id, a.reason, a.before,
             oi.order_id, oi.name AS item
      FROM audit_log a
      LEFT JOIN order_items oi ON oi.id = a.entity_id
      WHERE a.restaurant_id = ${restaurantId}::uuid
        AND a.action IN ('ORDER_ITEM_VOIDED', 'ORDER_ITEM_CANCELLED')
        AND a.entity_type = 'order_item'
        AND a.business_date BETWEEN ${range.from}::date AND ${range.to}::date
        AND a.before ->> 'state' = ANY(${COOKED}::text[])`;
    return rows.map((row) => ({
      ...EMPTY,
      flagId: `CANCELLED_AFTER_PREP:${row.id}`,
      kind: 'CANCELLED_AFTER_PREP',
      at: row.occurred_at.toISOString(),
      businessDate: isoDateOf(row.business_date),
      byId: row.actor_id,
      approvedById: row.approver_id,
      reason: row.reason,
      orderId: row.order_id,
      item: row.item,
      quantity: Math.max(0, intField(row.before, 'quantity') ?? 0),
      amount: Math.max(0, intField(row.before, 'lineTotal') ?? 0),
    }));
  }

  /**
   * Items sent to the kitchen and never on a settled bill, once their table has left (its session
   * closed) or, without a table, once their business date is over. Combo parts are billed through
   * their combo, so only whole lines count. The flag is about whoever ordered the item (or
   * accepted it, for a diner's own order).
   */
  private async sentNotBilled(
    restaurantId: string,
    range: ReportRangeQuery,
    today: string,
  ): Promise<Draft[]> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        order_id: string;
        name: string;
        quantity: number;
        line_total: number;
        sent_at: Date;
        business_date: Date;
        ordered_by: string | null;
        approved_by_id: string | null;
        kot_number: number | null;
      }[]
    >`
      SELECT oi.id, oi.order_id, oi.name, oi.quantity, oi.line_total, oi.sent_at,
             oi.business_date, coalesce(oi.created_by_id, o.created_by_id) AS ordered_by,
             oi.approved_by_id,
             (SELECT min(k.kot_number) FROM kot_lines kl JOIN kots k ON k.id = kl.kot_id
              WHERE kl.order_item_id = oi.id) AS kot_number
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN table_sessions ts ON ts.id = o.table_session_id
      WHERE oi.restaurant_id = ${restaurantId}::uuid
        AND oi.business_date BETWEEN ${range.from}::date AND ${range.to}::date
        AND oi.sent_at IS NOT NULL AND oi.parent_order_item_id IS NULL
        AND oi.state NOT IN ('REJECTED', 'CANCELLED', 'VOIDED')
        AND (ts.status = 'CLOSED' OR (ts.id IS NULL AND oi.business_date < ${today}::date))
        AND NOT EXISTS (
          SELECT 1 FROM invoice_lines il
          JOIN invoices i ON i.id = il.invoice_id AND il.version = i.version
          WHERE il.order_item_id = oi.id AND i.status = 'SETTLED'
        )`;
    return rows.map((row) => ({
      ...EMPTY,
      flagId: `SENT_NOT_BILLED:${row.id}`,
      kind: 'SENT_NOT_BILLED',
      at: row.sent_at.toISOString(),
      businessDate: isoDateOf(row.business_date),
      byId: row.ordered_by ?? row.approved_by_id,
      approvedById: row.ordered_by === null ? null : row.approved_by_id,
      orderId: row.order_id,
      kotNumber: row.kot_number,
      item: row.name,
      quantity: row.quantity,
      amount: row.line_total,
    }));
  }

  /** The cash drawer opened without a sale (BILL-016). */
  private async noSaleOpenings(restaurantId: string, range: ReportRangeQuery): Promise<Draft[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        restaurantId,
        action: 'CASH_DRAWER_OPENED',
        businessDate: { gte: new Date(range.from), lte: new Date(range.to) },
      },
      select: {
        id: true,
        occurredAt: true,
        businessDate: true,
        actorId: true,
        approverId: true,
        reason: true,
      },
    });
    return rows.map((row) => ({
      ...EMPTY,
      flagId: `NO_SALE_DRAWER:${row.id}`,
      kind: 'NO_SALE_DRAWER',
      at: row.occurredAt.toISOString(),
      businessDate: isoDateOf(row.businessDate),
      byId: row.actorId,
      approvedById: row.approverId,
      reason: row.reason,
    }));
  }

  /** Names for the people the report mentions, read once. */
  private async names(ids: readonly (string | null)[]): Promise<Names> {
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
