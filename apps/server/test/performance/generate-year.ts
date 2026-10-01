import { addDays } from '@rp/domain';
import type { PrismaService } from '../../src/database/prisma.service.js';

/**
 * A year of a busy restaurant at the BRD's design capacity (§7.2: 2,000 orders a day, 100 tables,
 * 1,000 dishes), written straight into the database with set-based SQL so it takes minutes, not
 * hours. Every id and figure is derived from the day and the order number, so each run measures
 * the same data. Per order: four lines (one in a hundred cancelled, one voided), a kitchen
 * ticket, an invoice (one in twenty with 10 % off, one in five hundred voided) with its lines,
 * tax lines and payment, two alerts, suggestion events and the audit entries the reports read.
 */
export interface YearRefs {
  readonly restaurantId: string;
  readonly deviceId: string;
  readonly waiterId: string;
  readonly cashierId: string;
  readonly managerId: string;
  readonly taxGroupId: string;
  readonly stationId: string;
  readonly seriesId: string;
}

export interface YearShape {
  /** The last business date; the year ends on it. */
  readonly lastDay: string;
  readonly days: number;
  readonly ordersPerDay: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A version-4 UUID derived from text, so ids are stable across runs and valid for the API. */
function id(text: string): string {
  return `(overlay(overlay(md5(${text}) placing '4' from 13) placing '8' from 17))::uuid`;
}

export async function generateYear(
  prisma: PrismaService,
  refs: YearRefs,
  shape: YearShape,
): Promise<{ readonly firstDay: string; readonly rows: Record<string, number> }> {
  for (const value of Object.values(refs) as string[]) {
    if (!UUID.test(value)) throw new Error(`Not a UUID: ${value}`);
  }
  const firstDay = addDays(shape.lastDay, -(shape.days - 1));
  const R = `'${refs.restaurantId}'::uuid`;
  const ORDERS = String(shape.ordersPerDay);
  // Each order: day index i, number n; dine-in unless n is a multiple of 5; source by n mod 4.
  const days = `(SELECT i, ('${firstDay}'::date + i) AS day
                 FROM generate_series(0, ${String(shape.days - 1)}) AS i)`;
  const at = (offset: string) =>
    `((d.day::timestamp + time '06:30' + n * interval '20 seconds' + ${offset}) AT TIME ZONE 'UTC')`;
  const statements: [string, string][] = [
    [
      'table_sessions',
      `INSERT INTO table_sessions (id, restaurant_id, table_id, business_date, status, covers,
                                   waiter_id, opened_at, closed_at)
       SELECT ${id("'s:' || d.i || ':' || n")}, ${R}, t.id, d.day, 'CLOSED', 2 + n % 3,
              '${refs.waiterId}'::uuid, ${at("interval '0 s'")},
              ${at("interval '50 minutes' + (n % 40) * interval '1 minute'")}
       FROM ${days} d CROSS JOIN generate_series(1, ${ORDERS}) AS n
       JOIN tables t ON t.restaurant_id = ${R} AND t.label = 'T' || (1 + n % 100)
       WHERE n % 5 <> 0`,
    ],
    [
      'orders',
      `INSERT INTO orders (id, restaurant_id, business_date, order_number, order_type, source,
                           status, table_session_id, table_id, created_by_id, device_id, created_at)
       SELECT ${id("'o:' || d.i || ':' || n")}, ${R}, d.day, n,
              (CASE WHEN n % 5 = 0 THEN 'TAKEAWAY' ELSE 'DINE_IN' END)::"OrderType",
              ((ARRAY['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR'])[1 + n % 4])::"OrderSource",
              'CLOSED',
              CASE WHEN n % 5 = 0 THEN NULL ELSE ${id("'s:' || d.i || ':' || n")} END,
              CASE WHEN n % 5 = 0 THEN NULL ELSE t.id END,
              CASE n % 4 WHEN 0 THEN '${refs.cashierId}'::uuid
                         WHEN 1 THEN '${refs.waiterId}'::uuid END,
              '${refs.deviceId}'::uuid, ${at("interval '0 s'")}
       FROM ${days} d CROSS JOIN generate_series(1, ${ORDERS}) AS n
       JOIN tables t ON t.restaurant_id = ${R} AND t.label = 'T' || (1 + n % 100)`,
    ],
    [
      'order_items',
      `INSERT INTO order_items (id, restaurant_id, order_id, business_date, item_id, name, quantity,
                                unit_price, line_total, tax_group_id, tax_rates, station_id, state,
                                created_by_id, approved_by_id, sent_at, preparing_at, ready_at,
                                picked_up_at, served_at, ended_at, end_reason, recommendation_layer)
       SELECT ${id("'i:' || d.i || ':' || n || ':' || k")}, ${R}, ${id("'o:' || d.i || ':' || n")},
              d.day, it.id, it.name, q.q, it.base_price, it.base_price * q.q,
              '${refs.taxGroupId}'::uuid,
              '[{"code":"CGST","rateBp":250},{"code":"SGST","rateBp":250}]'::jsonb,
              '${refs.stationId}'::uuid, st.state::"OrderItemState",
              CASE n % 4 WHEN 0 THEN '${refs.cashierId}'::uuid
                         WHEN 1 THEN '${refs.waiterId}'::uuid END,
              CASE WHEN n % 4 IN (2, 3) THEN '${refs.waiterId}'::uuid END,
              ${at("interval '30 s'")},
              CASE WHEN st.state <> 'CANCELLED' THEN ${at("interval '60 s'")} END,
              CASE WHEN st.state = 'SERVED' THEN ${at("interval '60 s' + (300 + (n * 7 + k) % 900) * interval '1 s'")} END,
              CASE WHEN st.state = 'SERVED' THEN ${at("interval '60 s' + (300 + (n * 7 + k) % 900 + 30 + n % 120) * interval '1 s'")} END,
              CASE WHEN st.state = 'SERVED' THEN ${at("interval '60 s' + (300 + (n * 7 + k) % 900 + 90 + n % 120) * interval '1 s'")} END,
              CASE WHEN st.state <> 'SERVED' THEN ${at("interval '120 s'")} END,
              CASE WHEN st.state <> 'SERVED' THEN 'Guest changed their mind' END,
              CASE WHEN k = 0 AND n % 3 = 0
                   THEN ((ARRAY['RULE', 'LEARNED', 'BEST_SELLER'])[1 + n % 9 / 3])::"RecommendationLayer" END
       FROM ${days} d CROSS JOIN generate_series(1, ${ORDERS}) AS n
       CROSS JOIN generate_series(0, 3) AS k
       CROSS JOIN LATERAL (SELECT 1 + (n + k) % 2 AS q) AS q
       CROSS JOIN LATERAL (SELECT CASE WHEN k = 3 AND n % 100 = 1 THEN 'CANCELLED'
                                       WHEN k = 3 AND n % 100 = 2 THEN 'VOIDED'
                                       ELSE 'SERVED' END AS state) AS st
       JOIN items it ON it.restaurant_id = ${R}
                    AND it.name = 'Dish ' || ((n * 4 + k * 37 + d.i) % 1000)`,
    ],
    [
      'kots',
      `INSERT INTO kots (id, restaurant_id, business_date, kot_number, order_id, station_id,
                         created_at)
       SELECT ${id("'k:' || o.id")}, ${R}, o.business_date, o.order_number, o.id,
              '${refs.stationId}'::uuid, o.created_at
       FROM orders o WHERE o.restaurant_id = ${R} AND o.business_date >= '${firstDay}'`,
    ],
    [
      'invoices',
      `INSERT INTO invoices (id, restaurant_id, business_date, invoice_date, financial_year,
                             series_id, sequence, invoice_number, status, order_id,
                             table_session_id, price_mode, subtotal, discount_total, tax_total,
                             grand_total, issued_by_id, issued_at, version)
       SELECT ${id("'v:' || o.id")}, ${R}, o.business_date, o.business_date,
              CASE WHEN extract(month FROM o.business_date) >= 4
                   THEN to_char(o.business_date, 'YY') || '-' ||
                        to_char(o.business_date + interval '1 year', 'YY')
                   ELSE to_char(o.business_date - interval '1 year', 'YY') || '-' ||
                        to_char(o.business_date, 'YY') END,
              '${refs.seriesId}'::uuid, row_number() OVER (ORDER BY o.business_date, o.order_number),
              'INV/' || row_number() OVER (ORDER BY o.business_date, o.order_number),
              'ISSUED', o.id, o.table_session_id, 'TAX_EXCLUSIVE',
              b.subtotal, b.discount, b.tax, b.subtotal - b.discount + b.tax,
              '${refs.cashierId}'::uuid, o.created_at + interval '40 minutes', 1
       FROM orders o
       JOIN LATERAL (
         SELECT sum(oi.line_total) AS subtotal,
                sum(CASE WHEN o.order_number % 20 = 0 THEN oi.line_total / 10 ELSE 0 END) AS discount,
                sum(CASE WHEN o.order_number % 20 = 0 THEN oi.line_total * 9 / 200
                         ELSE oi.line_total / 20 END) AS tax
         FROM order_items oi WHERE oi.order_id = o.id AND oi.state = 'SERVED'
       ) b ON true
       WHERE o.restaurant_id = ${R} AND o.business_date >= '${firstDay}'`,
    ],
    [
      'invoice_lines',
      `INSERT INTO invoice_lines (id, restaurant_id, invoice_id, order_item_id, description,
                                  quantity, unit_price, line_total, discount, taxable_value,
                                  tax_group_id, sac_code, version)
       SELECT ${id("'l:' || oi.id")}, ${R}, ${id("'v:' || oi.order_id")}, oi.id, oi.name,
              oi.quantity, oi.unit_price, oi.line_total, x.discount, oi.line_total - x.discount,
              oi.tax_group_id, '996331', 1
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       CROSS JOIN LATERAL (SELECT CASE WHEN o.order_number % 20 = 0 THEN oi.line_total / 10
                                       ELSE 0 END AS discount) x
       WHERE oi.restaurant_id = ${R} AND oi.business_date >= '${firstDay}'
         AND oi.state = 'SERVED'`,
    ],
    [
      'tax_lines',
      `INSERT INTO tax_lines (id, restaurant_id, invoice_id, tax_group_id, code, rate_bp,
                              taxable_value, amount, version)
       SELECT ${id("'t:' || i.id || ':' || c.code")}, ${R}, i.id, '${refs.taxGroupId}'::uuid,
              c.code, 250, i.subtotal - i.discount_total,
              CASE c.code WHEN 'CGST' THEN i.tax_total / 2 ELSE i.tax_total - i.tax_total / 2 END, 1
       FROM invoices i CROSS JOIN (VALUES ('CGST'), ('SGST')) AS c (code)
       WHERE i.restaurant_id = ${R} AND i.business_date >= '${firstDay}'`,
    ],
    [
      'voided invoices',
      `UPDATE invoices i SET status = 'VOIDED', voided_at = i.issued_at + interval '5 minutes',
                             void_reason = 'Wrong table'
       FROM orders o
       WHERE o.id = i.order_id AND i.restaurant_id = ${R} AND i.business_date >= '${firstDay}'
         AND o.order_number % 500 = 7`,
    ],
    [
      'payments',
      `INSERT INTO payments (id, restaurant_id, business_date, invoice_id, mode, amount,
                             received_by_id, created_at)
       SELECT ${id("'p:' || i.id")}, ${R}, i.business_date, i.id,
              ((ARRAY['CASH', 'UPI', 'CARD'])[1 + i.sequence % 3])::"PaymentMode", i.grand_total,
              '${refs.cashierId}'::uuid, i.issued_at + interval '5 minutes'
       FROM invoices i
       WHERE i.restaurant_id = ${R} AND i.business_date >= '${firstDay}' AND i.status <> 'VOIDED'`,
    ],
    [
      'discounts',
      `INSERT INTO discounts (id, restaurant_id, business_date, invoice_id, kind, rate_bp, amount,
                              reason, applied_by_id)
       SELECT ${id("'d:' || i.id")}, ${R}, i.business_date, i.id, 'PERCENT', 1000,
              i.discount_total, 'Regular guest', '${refs.cashierId}'::uuid
       FROM invoices i
       WHERE i.restaurant_id = ${R} AND i.business_date >= '${firstDay}' AND i.discount_total > 0`,
    ],
    [
      'audit_log',
      `INSERT INTO audit_log (id, restaurant_id, business_date, occurred_at, action, actor_id,
                              approver_id, device_id, entity_type, entity_id, before, after,
                              reason, chain_seq, prev_hash, hash)
       SELECT ${id("'a:' || e.action || ':' || e.entity_id")}, ${R}, e.business_date, e.at,
              e.action, e.actor_id, e.approver_id, '${refs.deviceId}'::uuid, e.entity_type,
              e.entity_id, e.before, e.after, e.reason,
              1000000 + row_number() OVER (ORDER BY e.at, e.action, e.entity_id),
              md5(e.action || e.entity_id), md5(e.entity_id || e.action)
       FROM (
         SELECT 'ORDER_SUBMITTED' AS action, o.id AS entity_id, 'order' AS entity_type,
                o.business_date, o.created_at AS at, o.created_by_id AS actor_id,
                NULL::uuid AS approver_id, NULL::jsonb AS before, NULL::jsonb AS after,
                NULL AS reason
         FROM orders o WHERE o.restaurant_id = ${R} AND o.business_date >= '${firstDay}'
         UNION ALL
         SELECT 'INVOICE_ISSUED', i.id, 'invoice', i.business_date, i.issued_at, i.issued_by_id,
                NULL, NULL, jsonb_build_object('grandTotal', i.grand_total), NULL
         FROM invoices i WHERE i.restaurant_id = ${R} AND i.business_date >= '${firstDay}'
         UNION ALL
         SELECT CASE oi.state WHEN 'CANCELLED' THEN 'ORDER_ITEM_CANCELLED'
                              ELSE 'ORDER_ITEM_VOIDED' END,
                oi.id, 'order_item', oi.business_date, oi.ended_at, '${refs.waiterId}'::uuid,
                CASE WHEN oi.state = 'VOIDED' THEN '${refs.managerId}'::uuid END,
                jsonb_build_object('state', CASE oi.state WHEN 'CANCELLED' THEN 'SENT'
                                                          ELSE 'PREPARING' END,
                                   'quantity', oi.quantity, 'lineTotal', oi.line_total),
                NULL, oi.end_reason
         FROM order_items oi
         WHERE oi.restaurant_id = ${R} AND oi.business_date >= '${firstDay}'
           AND oi.state IN ('CANCELLED', 'VOIDED')
         UNION ALL
         SELECT 'INVOICE_REPRINTED', i.id, 'invoice', i.business_date,
                i.issued_at + interval '2 minutes', i.issued_by_id, NULL,
                jsonb_build_object('printCount', 1), jsonb_build_object('printCount', 2), NULL
         FROM invoices i WHERE i.restaurant_id = ${R} AND i.business_date >= '${firstDay}'
           AND i.sequence % 50 = 0
         UNION ALL
         SELECT 'INVOICE_VOIDED', i.id, 'invoice', i.business_date, i.voided_at,
                '${refs.managerId}'::uuid, NULL,
                jsonb_build_object('status', 'ISSUED', 'invoiceNumber', i.invoice_number,
                                   'grandTotal', i.grand_total), NULL, i.void_reason
         FROM invoices i WHERE i.restaurant_id = ${R} AND i.business_date >= '${firstDay}'
           AND i.status = 'VOIDED'
         UNION ALL
         SELECT 'KOT_REPRINTED', k.id, 'kot', k.business_date, k.created_at + interval '1 minute',
                '${refs.waiterId}'::uuid, NULL, NULL,
                jsonb_build_object('kotNumber', k.kot_number), 'Paper jam'
         FROM kots k WHERE k.restaurant_id = ${R} AND k.business_date >= '${firstDay}'
           AND k.kot_number % 200 = 0
       ) e`,
    ],
    [
      'alerts',
      `INSERT INTO alerts (id, restaurant_id, business_date, type, status, kot_id,
                           raised_by_device_id, recipient_ids, escalated_at, escalated_to,
                           acknowledged_at, acknowledged_by_id, created_at)
       SELECT ${id("'al:' || o.id || ':' || a.kind")}, ${R}, o.business_date,
              CASE a.kind WHEN 0 THEN 'ITEM_READY'
                          ELSE (CASE WHEN o.order_number % 25 = 0 THEN 'READY_NOT_COLLECTED'
                                     ELSE 'BILL_REQUEST' END) END,
              'ACKNOWLEDGED', ${id("'k:' || o.id")},
              CASE WHEN a.kind = 1 AND o.order_number % 50 = 0 THEN '${refs.deviceId}'::uuid END,
              ARRAY['${refs.waiterId}'::uuid] ||
                CASE WHEN a.kind = 1 AND o.order_number % 10 = 0
                     THEN ARRAY['${refs.managerId}'::uuid] ELSE ARRAY[]::uuid[] END,
              CASE WHEN a.kind = 1 AND o.order_number % 10 = 0
                   THEN o.created_at + interval '20 minutes' END,
              CASE WHEN a.kind = 1 AND o.order_number % 10 = 0
                   THEN ARRAY['${refs.managerId}'::uuid] ELSE ARRAY[]::uuid[] END,
              o.created_at + interval '19 minutes' + (30 + o.order_number % 90) * interval '1 s',
              '${refs.waiterId}'::uuid, o.created_at + interval '19 minutes'
       FROM orders o CROSS JOIN (VALUES (0), (1)) AS a (kind)
       WHERE o.restaurant_id = ${R} AND o.business_date >= '${firstDay}'`,
    ],
    [
      'service_requests',
      `INSERT INTO service_requests (id, restaurant_id, business_date, table_session_id, table_id,
                                     type, state, source, acknowledged_at, acknowledged_by_id,
                                     closed_at, created_at)
       SELECT ${id("'sr:' || s.id")}, ${R}, s.business_date, s.id, s.table_id, 'WATER',
              'RESOLVED', 'TABLE_TABLET', s.opened_at + interval '10 minutes 40 seconds',
              '${refs.waiterId}'::uuid, s.opened_at + interval '12 minutes',
              s.opened_at + interval '10 minutes'
       FROM table_sessions s
       WHERE s.restaurant_id = ${R} AND s.business_date >= '${firstDay}'
         AND get_byte(decode(md5(s.id::text), 'hex'), 0) % 4 = 0`,
    ],
    [
      'recommendation_events',
      `INSERT INTO recommendation_events (id, restaurant_id, business_date, kind, layer, item_id,
                                          channel, table_session_id, order_item_id, created_at)
       SELECT ${id("'re:' || oi.id || ':' || e.kind || ':' || e.copy")}, ${R}, oi.business_date,
              e.kind::"RecommendationEventKind",
              coalesce(oi.recommendation_layer, 'BEST_SELLER'), oi.item_id, 'WAITER_APP',
              o.table_session_id,
              CASE WHEN e.kind = 'ORDERED' THEN oi.id END, oi.sent_at
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       CROSS JOIN LATERAL (
         SELECT 'IMPRESSION' AS kind, copy FROM generate_series(1, 3) AS copy
         UNION ALL
         SELECT kind, 1 FROM unnest(ARRAY['TAP', 'ADD_TO_CART', 'ORDERED']) AS kind
         WHERE oi.recommendation_layer IS NOT NULL
       ) e
       -- Suggested lines, and about one line in sixteen shown as a suggestion but not taken.
       WHERE oi.restaurant_id = ${R} AND oi.business_date >= '${firstDay}'
         AND (oi.recommendation_layer IS NOT NULL OR oi.id::text LIKE '%0')`,
    ],
    [
      'shifts',
      `INSERT INTO shifts (id, restaurant_id, business_date, staff_id, device_id, status,
                           opened_at, closed_at, opening_float, expected_cash, counted_cash,
                           variance)
       SELECT ${id("'sh:' || d.i || ':' || h")}, ${R}, d.day, '${refs.cashierId}'::uuid,
              '${refs.deviceId}'::uuid, 'CLOSED',
              (d.day::timestamp + time '05:00' + h * interval '8 hours') AT TIME ZONE 'UTC',
              (d.day::timestamp + time '13:00' + h * interval '8 hours') AT TIME ZONE 'UTC',
              500000, 500000, 500000, 0
       FROM ${days} d CROSS JOIN generate_series(0, 1) AS h`,
    ],
  ];
  const rows: Record<string, number> = {};
  for (const [name, sql] of statements) {
    rows[name] = await prisma.$executeRawUnsafe(sql);
  }
  await prisma.$executeRawUnsafe('ANALYZE');
  return { firstDay, rows };
}
