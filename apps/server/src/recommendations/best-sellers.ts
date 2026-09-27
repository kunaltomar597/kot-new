import { Injectable, Logger } from '@nestjs/common';
import { addDays, type DailyWindow, type ItemCount } from '@rp/domain';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';

/** What a best-seller ranking is counted over (REC-004). */
export interface BestSellerWindow {
  readonly restaurantId: string;
  /** The last business date counted; `days` business dates up to and including it. */
  readonly businessDate: string;
  /** `reco.bestSellerDays`. */
  readonly days: number;
  /** The daypart's hours in local time, or null for the whole day. */
  readonly hours: DailyWindow | null;
  readonly timeZone: string;
}

interface CacheEntry {
  at: number;
  counts: Promise<ItemCount[]>;
  refreshing: boolean;
}

/** A ranking is read again at most this often; the old one is served while it is. */
const FRESH_MS = 10 * 60_000;
/** Rankings not asked for this long (another business date or daypart) are dropped. */
const DROP_MS = 60 * 60_000;

/**
 * Best sellers by quantity (REC-004): the items sold over the last `reco.bestSellerDays` business
 * dates, counted in the daypart's hours (local time) or over the whole day. Only what reached the
 * kitchen counts: lines waiting for approval, rejected, cancelled or voided do not, nor combo parts
 * (the combo itself counts). Counting runs over thousands of order lines, so each ranking is kept
 * for ten minutes and refreshed in the background while the old one is served (REC-011).
 */
@Injectable()
export class BestSellers {
  private readonly logger = new Logger(BestSellers.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  get(window: BestSellerWindow, now: number = Date.now()): Promise<ItemCount[]> {
    for (const [key, entry] of this.cache) {
      if (now - entry.at > DROP_MS) this.cache.delete(key);
    }
    const key = JSON.stringify([
      window.restaurantId,
      window.businessDate,
      window.days,
      window.hours?.start ?? null,
      window.hours?.end ?? null,
      window.timeZone,
    ]);
    const cached = this.cache.get(key);
    if (cached === undefined) {
      const counts = this.count(window);
      counts.catch(() => this.cache.delete(key));
      this.cache.set(key, { at: now, counts, refreshing: false });
      return counts;
    }
    if (now - cached.at > FRESH_MS && !cached.refreshing) {
      cached.refreshing = true;
      this.count(window).then(
        (counts) =>
          this.cache.set(key, { at: now, counts: Promise.resolve(counts), refreshing: false }),
        (error: unknown) => {
          cached.refreshing = false;
          this.logger.warn(`Best sellers could not be counted again: ${String(error)}`);
        },
      );
    }
    return cached.counts;
  }

  /** Forget every ranking (tests that add orders and want them counted at once). */
  invalidate(): void {
    this.cache.clear();
  }

  private async count(window: BestSellerWindow): Promise<ItemCount[]> {
    const from = addDays(window.businessDate, -window.days);
    const local = Prisma.sql`(created_at AT TIME ZONE ${window.timeZone})::time`;
    const hours =
      window.hours === null
        ? Prisma.sql`TRUE`
        : window.hours.start <= window.hours.end
          ? Prisma.sql`(${local} >= ${window.hours.start}::time AND ${local} < ${window.hours.end}::time)`
          : Prisma.sql`(${local} >= ${window.hours.start}::time OR ${local} < ${window.hours.end}::time)`;
    const rows = await this.prisma.$queryRaw<{ itemId: string; quantity: number }[]>`
      SELECT item_id::text AS "itemId", SUM(quantity)::int AS quantity
      FROM order_items
      WHERE restaurant_id = ${window.restaurantId}::uuid
        AND business_date > ${from}::date
        AND business_date <= ${window.businessDate}::date
        AND parent_order_item_id IS NULL
        AND state IN ('SENT', 'PREPARING', 'READY', 'PICKED_UP', 'SERVED')
        AND ${hours}
      GROUP BY item_id`;
    return rows;
  }
}
