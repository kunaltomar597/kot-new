import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { LearnedRecommendationsResponse } from '@rp/contracts';
import { addDays, learnAssociations, type LearnedPair } from '@rp/domain';
import { currentBusinessDate, dbDate, isoDateOf } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { PrismaService } from '../database/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { RECOMMENDATION_CLOCK, type RecommendationClock } from './clock.js';

export const LEARNING_OPTIONS = Symbol('LEARNING_OPTIONS');

export interface LearningOptions {
  /** Wait after start-up before the first check (let the restaurant's morning start). */
  readonly firstDelayMs: number;
  /** How often to check whether a restaurant is due. */
  readonly checkEveryMs: number;
}

export const DEFAULT_LEARNING_OPTIONS: LearningOptions = {
  firstDelayMs: 5 * 60_000,
  checkEveryMs: 60 * 60_000,
};

/** What reached the kitchen counts, as for best sellers: nothing rejected, cancelled or voided. */
const MADE = ['SENT', 'PREPARING', 'READY', 'PICKED_UP', 'SERVED'] as const;
/** The strongest rules shown to the manager. */
const SHOWN = 50;

/**
 * Learned recommendations (P6-02, REC-003): each business day, the first check after it begins
 * (on a PC that is on at 04:00, soon after; on one switched off overnight, soon after start-up)
 * learns "frequently ordered together" rules from the restaurant's own orders over the last
 * `reco.learningWindowDays`, on this PC, with no cloud (NFR-A01). A basket is a table's visit
 * (every order of its session), or a takeaway order on its own; dishes count when they reached
 * the kitchen, combos as themselves. The rules replace the last run's and are kept in memory for
 * the engine, which must answer within 200 ms (NFR-P09).
 */
@Injectable()
export class LearnedAssociations implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(LearnedAssociations.name);
  private readonly cache = new Map<string, Promise<LearnedPair[]>>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    @Inject(RECOMMENDATION_CLOCK) private readonly clock: RecommendationClock,
    @Inject(LEARNING_OPTIONS) private readonly options: LearningOptions,
  ) {}

  onApplicationBootstrap(): void {
    this.schedule(this.options.firstDelayMs);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** The rules the engine uses: the last run's, strongest first (empty before the first). */
  pairs(restaurantId: string): Promise<LearnedPair[]> {
    let cached = this.cache.get(restaurantId);
    if (cached === undefined) {
      cached = this.prisma.learnedAssociation
        .findMany({
          where: { restaurantId },
          orderBy: [{ score: 'desc' }, { pairCount: 'desc' }],
          select: { fromItemId: true, toItemId: true, score: true },
        })
        .then((rows) =>
          rows.map(({ fromItemId, toItemId, score }) => ({ fromItemId, toItemId, score })),
        );
      cached.catch(() => this.cache.delete(restaurantId));
      this.cache.set(restaurantId, cached);
    }
    return cached;
  }

  /** Forget what is kept in memory (tests and tools that write the rules themselves). */
  invalidate(): void {
    this.cache.clear();
  }

  /** Learns now for one restaurant, replacing what the last run learned. */
  async learn(restaurantId: string): Promise<LearnedRecommendationsResponse> {
    const started = performance.now();
    const settings = await this.settings.snapshot(restaurantId);
    const to = await currentBusinessDate(this.prisma, restaurantId, this.clock.now());
    const from = addDays(to, 1 - settings.get('reco.learningWindowDays'));
    const [baskets, orders] = await Promise.all([
      this.prisma.$queryRaw<{ items: string[] }[]>`
        SELECT array_agg(DISTINCT oi.item_id::text) AS items
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE oi.restaurant_id = ${restaurantId}::uuid
          AND oi.business_date >= ${from}::date
          AND oi.business_date <= ${to}::date
          AND oi.parent_order_item_id IS NULL
          AND oi.state::text IN (${MADE[0]}, ${MADE[1]}, ${MADE[2]}, ${MADE[3]}, ${MADE[4]})
        GROUP BY coalesce(o.table_session_id, o.id)`,
      this.prisma.$queryRaw<{ count: number }[]>`
        SELECT count(DISTINCT oi.order_id)::int AS count
        FROM order_items oi
        WHERE oi.restaurant_id = ${restaurantId}::uuid
          AND oi.business_date >= ${from}::date
          AND oi.business_date <= ${to}::date
          AND oi.parent_order_item_id IS NULL
          AND oi.state::text IN (${MADE[0]}, ${MADE[1]}, ${MADE[2]}, ${MADE[3]}, ${MADE[4]})`,
    ]);
    const result = learnAssociations(
      baskets.map((basket) => basket.items),
      orders[0]?.count ?? 0,
      {
        minSupportBp: settings.get('reco.minSupportBp'),
        minConfidenceBp: settings.get('reco.minConfidenceBp'),
        minLiftPercent: settings.get('reco.minLiftPercent'),
        minOrders: settings.get('reco.minOrders'),
      },
    );
    const durationMs = Math.round(performance.now() - started);
    await this.prisma.$transaction(async (tx) => {
      await tx.learnedAssociation.deleteMany({ where: { restaurantId } });
      await tx.learnedAssociation.createMany({
        data: result.associations.map((association) => ({
          id: newId(),
          restaurantId,
          ...association,
        })),
      });
      await tx.learningRun.create({
        data: {
          id: newId(),
          restaurantId,
          windowFrom: dbDate(from),
          windowTo: dbDate(to),
          orders: result.orders,
          baskets: result.baskets,
          associations: result.associations.length,
          active: result.active,
          durationMs,
        },
      });
    });
    this.cache.delete(restaurantId);
    this.logger.log(
      {
        restaurantId,
        orders: result.orders,
        baskets: result.baskets,
        associations: result.associations.length,
        durationMs,
      },
      result.active ? 'Learned what is ordered together' : 'Too few orders to learn from yet',
    );
    return this.status(restaurantId);
  }

  /** The last run and its strongest rules, with the dishes' names, for the manager. */
  async status(restaurantId: string): Promise<LearnedRecommendationsResponse> {
    const [run, strongest, settings] = await Promise.all([
      this.prisma.learningRun.findFirst({
        where: { restaurantId },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.learnedAssociation.findMany({
        where: { restaurantId },
        orderBy: [{ score: 'desc' }, { pairCount: 'desc' }],
        take: SHOWN,
      }),
      this.settings.snapshot(restaurantId),
    ]);
    const names = new Map(
      (
        await this.prisma.item.findMany({
          where: {
            restaurantId,
            id: { in: strongest.flatMap((entry) => [entry.fromItemId, entry.toItemId]) },
          },
          select: { id: true, name: true },
        })
      ).map((item) => [item.id, item.name]),
    );
    return {
      lastRun:
        run === null
          ? null
          : {
              at: run.createdAt.toISOString(),
              windowFrom: isoDateOf(run.windowFrom),
              windowTo: isoDateOf(run.windowTo),
              orders: run.orders,
              baskets: run.baskets,
              associations: run.associations,
              active: run.active,
              durationMs: run.durationMs,
            },
      minOrders: settings.get('reco.minOrders'),
      associations: strongest.map((entry) => ({
        fromItemId: entry.fromItemId,
        fromName: names.get(entry.fromItemId) ?? '',
        toItemId: entry.toItemId,
        toName: names.get(entry.toItemId) ?? '',
        pairCount: entry.pairCount,
        supportBp: entry.supportBp,
        confidenceBp: entry.confidenceBp,
        liftPercent: entry.liftPercent,
      })),
    };
  }

  /** Runs every restaurant that has not learned yet this business day. */
  async learnWhereDue(): Promise<number> {
    const restaurants = await this.prisma.restaurant.findMany({ select: { id: true } });
    let ran = 0;
    for (const { id } of restaurants) {
      const [today, last] = await Promise.all([
        currentBusinessDate(this.prisma, id, this.clock.now()),
        this.prisma.learningRun.findFirst({
          where: { restaurantId: id },
          orderBy: { createdAt: 'desc' },
          select: { windowTo: true },
        }),
      ]);
      if (last !== null && isoDateOf(last.windowTo) >= today) continue;
      await this.learn(id);
      ran += 1;
    }
    return ran;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.learnWhereDue()
        .catch((error: unknown) => {
          this.logger.warn(
            { err: error },
            'Learning what is ordered together failed; trying later',
          );
        })
        .finally(() => {
          this.schedule(this.options.checkEveryMs);
        });
    }, delayMs);
    this.timer.unref();
  }
}
