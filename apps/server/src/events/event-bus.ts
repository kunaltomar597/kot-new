import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { DomainEvent, type DomainEventType } from '@rp/contracts';
import pg from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { ADVISORY_LOCKS } from '../database/advisory-locks.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { EventAudience } from './outbox.js';

/** The notification channel the outbox trigger signals on commit (migration `*_realtime_outbox`). */
export const OUTBOX_CHANNEL = 'rp_outbox';
const STREAM_ID_KEY = 'events.stream_id';
const CONSUMER_NAME = /^[a-z][a-z0-9.-]{1,62}$/;

export const EVENT_BUS_OPTIONS = Symbol('EVENT_BUS_OPTIONS');

export interface EventBusOptions {
  /** Safety-net poll for a missed notification or a lost LISTEN connection. */
  readonly pollIntervalMs: number;
  /** Rows numbered, published or handed to a consumer per database round trip. */
  readonly batchSize: number;
  /** First retry delay after a consumer fails; doubles per attempt up to `retryMaxMs`. */
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  /** Published events are kept this long for replay (and until every consumer is past them). */
  readonly retentionHours: number;
  readonly cleanupIntervalMs: number;
  /** LISTEN for commit notifications; off only in tests that exercise the polling fallback. */
  readonly listen: boolean;
}

export const DEFAULT_EVENT_BUS_OPTIONS: EventBusOptions = {
  pollIntervalMs: 2_000,
  batchSize: 200,
  retryBaseMs: 1_000,
  retryMaxMs: 60_000,
  retentionHours: 24,
  cleanupIntervalMs: 15 * 60_000,
  listen: true,
};

/** A committed event with its place in the delivery order. */
export interface PublishedEvent {
  readonly sequence: number;
  readonly event: DomainEvent;
  readonly audience: EventAudience;
}

export interface ConsumerContext {
  /** The transaction that also records the event as handled; write through it. */
  readonly tx: TransactionClient;
  readonly sequence: number;
}

/**
 * A durable, in-process subscriber (INT-001: modules react to each other's events, never to each
 * other's tables). It sees its event types in sequence order, at least once; a handler that throws
 * is retried with backoff and later events wait, so nothing is lost. Its database writes through
 * `context.tx` commit together with the inbox record of the event, so a redelivery is skipped:
 * effects inside the database happen exactly once. Effects outside it (a printer, a pager) must be
 * safe to repeat.
 */
export interface EventConsumer {
  /** Stable name; it keys the consumer's cursor and inbox records. */
  readonly name: string;
  readonly types: readonly DomainEventType[];
  /** Where a consumer seen for the first time starts: new events only (default) or all retained. */
  readonly startFrom?: 'next' | 'beginning';
  /**
   * After this many failed attempts on one event, the event is set aside (kept in the inbox with
   * the error) and the consumer moves on. Default: retry forever, never skip.
   */
  readonly maxAttempts?: number;
  handle(event: DomainEvent, context: ConsumerContext): Promise<void>;
}

/** Called in sequence order, synchronously, with every newly published batch in this process. */
export type PublishedListener = (events: readonly PublishedEvent[]) => void;

interface ConsumerState {
  readonly consumer: EventConsumer;
  readonly types: ReadonlySet<string>;
  retryAt?: number;
}

interface OutboxRow {
  readonly sequence: bigint | null;
  readonly restaurantId: string;
  readonly payload: Prisma.JsonValue;
  readonly audience: Prisma.JsonValue;
}

const OUTBOX_ROW = {
  sequence: true,
  restaurantId: true,
  payload: true,
  audience: true,
} as const satisfies Prisma.OutboxEventSelect;

/**
 * The in-process event bus and outbox dispatcher (P0-12, BRD §10.1 principle 3, §10.4).
 *
 * Producers write events with `appendEvent` in the transaction that makes the change. When it
 * commits, PostgreSQL notifies this dispatcher, which:
 *
 * 1. numbers the committed events: a gap-free `sequence`, assigned by one dispatcher at a time, so
 *    a reader that has seen sequence N has seen every event before N (clients resume from it);
 * 2. publishes them, in order, to live listeners (the Socket.io gateway) in this process;
 * 3. hands them to durable consumers, each at its own cursor, with retry and inbox de-duplication.
 */
@Injectable()
export class EventBus implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EventBus.name);
  private readonly consumers = new Map<string, ConsumerState>();
  private readonly listeners = new Set<PublishedListener>();
  private started = false;
  private stopped = false;
  private pending = false;
  private running: Promise<void> | undefined;
  private publishedHead = 0;
  private stream = '';
  private publishQueue: Promise<unknown> = Promise.resolve();
  private listener: pg.Client | undefined;
  private listenerRetryMs = 1_000;
  private readonly timers = new Set<NodeJS.Timeout>();
  private retryTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private startTimer: NodeJS.Timeout | undefined;
  private startRetryMs = 1_000;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EVENT_BUS_OPTIONS) private readonly options: EventBusOptions,
  ) {}

  /** Registers a durable consumer. Call from a constructor or `onModuleInit`, before start-up. */
  subscribe(consumer: EventConsumer): void {
    if (this.started) throw new Error(`Consumer ${consumer.name} subscribed after start-up`);
    if (!CONSUMER_NAME.test(consumer.name)) {
      throw new Error(`Invalid consumer name ${consumer.name}`);
    }
    if (this.consumers.has(consumer.name)) {
      throw new Error(`Consumer ${consumer.name} is already subscribed`);
    }
    if (consumer.maxAttempts !== undefined && consumer.maxAttempts < 1) {
      throw new Error(`Consumer ${consumer.name} needs maxAttempts of at least 1`);
    }
    this.consumers.set(consumer.name, { consumer, types: new Set(consumer.types) });
  }

  /** Adds a live listener; returns a function that removes it. */
  onPublished(listener: PublishedListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** False until the dispatcher could reach the database at start-up. */
  get ready(): boolean {
    return this.started;
  }

  /** The last sequence handed to live listeners in this process. */
  get head(): number {
    return this.publishedHead;
  }

  /**
   * Identifies this database's event history. Sequences are only comparable within one stream;
   * restoring a backup (DATA-004) must replace it so clients do a full refresh.
   */
  get streamId(): string {
    return this.stream;
  }

  /**
   * Runs `work` while no batch is being published, so what it sends to a client is ordered
   * correctly against live events (replay before joining rooms, heartbeat heads).
   */
  withPublishLock<T>(work: () => Promise<T> | T): Promise<T> {
    const result = this.publishQueue.then(() => work());
    this.publishQueue = result.catch(() => undefined);
    return result;
  }

  /** Published events of one restaurant with `after < sequence <= upTo`, in order. */
  async readPublished(input: {
    readonly restaurantId: string;
    readonly after: number;
    readonly upTo: number;
    readonly limit: number;
  }): Promise<PublishedEvent[]> {
    const rows = await this.prisma.outboxEvent.findMany({
      where: {
        restaurantId: input.restaurantId,
        sequence: { gt: BigInt(input.after), lte: BigInt(input.upTo) },
      },
      orderBy: { sequence: 'asc' },
      take: input.limit,
      select: OUTBOX_ROW,
    });
    return this.toPublished(rows);
  }

  /** The oldest sequence still stored; replay cannot reach further back. */
  async oldestRetained(): Promise<number | undefined> {
    const { _min } = await this.prisma.outboxEvent.aggregate({ _min: { sequence: true } });
    return _min.sequence === null ? undefined : Number(_min.sequence);
  }

  /** Schedules a dispatch round (also triggered by commit notifications and the poll). */
  wake(): void {
    if (!this.started || this.stopped) return;
    this.pending = true;
    if (this.running !== undefined) return;
    this.running = this.loop().finally(() => {
      this.running = undefined;
      if (this.pending) this.wake();
      else this.scheduleRetry();
    });
  }

  /** Dispatches until nothing is left that can run now (consumers in backoff wait). */
  async drain(): Promise<void> {
    this.wake();
    while (this.running !== undefined) await this.running;
  }

  /**
   * Starts dispatching. The server must come up even while the database is unreachable (the
   * health endpoint reports it), so a failed start is retried in the background.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.options.listen) void this.connectListener();
    this.every(this.options.pollIntervalMs, () => {
      this.wake();
    });
    this.every(this.options.cleanupIntervalMs, () => {
      if (!this.started) return;
      void this.cleanup().catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Outbox clean-up failed; retrying later');
      });
    });
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
    clearTimeout(this.retryTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.startTimer);
    while (this.running !== undefined) await this.running;
    const listener = this.listener;
    this.listener = undefined;
    await listener?.end().catch(() => undefined);
  }

  /**
   * Deletes published events older than the retention period that every consumer has handled,
   * always keeping the newest (so sequences never restart), and the matching inbox records.
   */
  async cleanup(now: Date = new Date()): Promise<number> {
    const before = new Date(now.getTime() - this.options.retentionHours * 3_600_000);
    const cursors = await this.prisma.eventConsumerCursor.findMany({
      where: { consumer: { in: [...this.consumers.keys()] } },
      select: { lastSequence: true },
    });
    const consumed =
      cursors.length === 0
        ? Prisma.empty
        : Prisma.sql`AND sequence <= ${cursors.reduce(
            (min, cursor) => (cursor.lastSequence < min ? cursor.lastSequence : min),
            cursors[0]?.lastSequence ?? 0n,
          )}`;
    // A prefix of the sequence, so what is kept is always contiguous for replay; under the
    // publish lock, so a replay in progress never loses rows between its checks and its reads.
    const deleted = await this.withPublishLock(
      () => this.prisma.$executeRaw`
        DELETE FROM outbox
        WHERE sequence <= (
            SELECT MAX(sequence) FROM outbox
            WHERE sequence IS NOT NULL AND published_at < ${before}
          )
          AND sequence < (SELECT MAX(sequence) FROM outbox)
          ${consumed}`,
    );
    await this.prisma.inboxMessage.deleteMany({
      where: {
        source: { startsWith: 'consumer:' },
        processedAt: { not: null },
        receivedAt: { lt: before },
      },
    });
    return deleted;
  }

  private async start(): Promise<void> {
    if (this.stopped) return;
    try {
      this.stream = await this.ensureStreamId();
      const head = await this.maxSequence();
      for (const state of this.consumers.values()) {
        await this.prisma.eventConsumerCursor.createMany({
          data: [
            {
              consumer: state.consumer.name,
              lastSequence: state.consumer.startFrom === 'beginning' ? 0n : BigInt(head),
            },
          ],
          skipDuplicates: true,
        });
      }
      // Live listeners start at the current head; clients replay anything older themselves.
      this.publishedHead = head;
      this.started = true;
      this.wake();
    } catch (error) {
      if (this.isStopped()) return;
      this.logger.error({ err: error }, 'The event dispatcher could not start; retrying');
      this.startTimer = setTimeout(() => void this.start(), this.startRetryMs);
      this.startTimer.unref();
      this.startRetryMs = Math.min(this.startRetryMs * 2, 30_000);
    }
  }

  /** Re-reads the flag after an await (a plain property check would be narrowed away). */
  private isStopped(): boolean {
    return this.stopped;
  }

  private every(intervalMs: number, tick: () => void): void {
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    this.timers.add(timer);
  }

  private async loop(): Promise<void> {
    while (this.pending && !this.stopped) {
      this.pending = false;
      await this.dispatch();
    }
  }

  private async dispatch(): Promise<void> {
    try {
      while ((await this.sequencePending()) === this.options.batchSize) {
        // A full batch: number the next one.
      }
      await this.publish();
      await this.runConsumers();
    } catch (error) {
      this.logger.error({ err: error }, 'Event dispatch failed; retrying on the next poll');
    }
  }

  /**
   * Numbers committed events that have no sequence yet, in write order, continuing from the
   * highest sequence. One dispatcher at a time (advisory lock), so numbers are never reused or
   * skipped, and a later number is always committed after an earlier one.
   */
  private async sequencePending(): Promise<number> {
    return this.prisma.transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${ADVISORY_LOCKS.outboxSequence})`;
      return tx.$executeRaw`
        WITH head AS (SELECT COALESCE(MAX(sequence), 0) AS last FROM outbox),
        pending AS (
          SELECT id, row_number() OVER (ORDER BY write_order) AS position
          FROM (
            SELECT id, write_order FROM outbox
            WHERE sequence IS NULL
            ORDER BY write_order
            LIMIT ${this.options.batchSize}
          ) AS waiting
        )
        UPDATE outbox
        SET sequence = head.last + pending.position, published_at = now(), updated_at = now()
        FROM head, pending
        WHERE outbox.id = pending.id`;
    });
  }

  private async publish(): Promise<void> {
    await this.withPublishLock(async () => {
      for (;;) {
        const rows = await this.prisma.outboxEvent.findMany({
          where: { sequence: { gt: BigInt(this.publishedHead) } },
          orderBy: { sequence: 'asc' },
          take: this.options.batchSize,
          select: OUTBOX_ROW,
        });
        const last = rows.at(-1)?.sequence;
        if (last === undefined || last === null) return;
        const events = this.toPublished(rows);
        for (const listener of this.listeners) {
          try {
            listener(events);
          } catch (error) {
            this.logger.error({ err: error }, 'A live event listener failed');
          }
        }
        this.publishedHead = Number(last);
        if (rows.length < this.options.batchSize) return;
      }
    });
  }

  private toPublished(rows: readonly OutboxRow[]): PublishedEvent[] {
    const events: PublishedEvent[] = [];
    for (const row of rows) {
      const event = DomainEvent.safeParse(row.payload);
      if (row.sequence === null || !event.success) {
        this.logger.error({ sequence: row.sequence?.toString() }, 'Stored event is unreadable');
        continue;
      }
      const audience = EventAudience.safeParse(row.audience ?? {});
      events.push({
        sequence: Number(row.sequence),
        event: event.data,
        audience: audience.success ? audience.data : {},
      });
    }
    return events;
  }

  private async runConsumers(): Promise<void> {
    for (const state of this.consumers.values()) {
      if (this.stopped) return;
      if (state.retryAt !== undefined && state.retryAt > Date.now()) continue;
      await this.runConsumer(state);
    }
  }

  private async runConsumer(state: ConsumerState): Promise<void> {
    const { name } = state.consumer;
    for (;;) {
      const cursor = await this.prisma.eventConsumerCursor.findUnique({
        where: { consumer: name },
      });
      if (cursor === null) return;
      const rows = await this.prisma.outboxEvent.findMany({
        where: { sequence: { gt: cursor.lastSequence } },
        orderBy: { sequence: 'asc' },
        take: this.options.batchSize,
        select: { ...OUTBOX_ROW, eventType: true },
      });
      let skippedTo: bigint | undefined;
      for (const row of rows) {
        if (row.sequence === null) continue;
        if (!state.types.has(row.eventType)) {
          skippedTo = row.sequence;
          continue;
        }
        skippedTo = undefined;
        if (!(await this.deliver(state, row, row.sequence))) return;
      }
      if (skippedTo !== undefined) await this.advance(name, skippedTo);
      if (rows.length < this.options.batchSize) return;
    }
  }

  /** Hands one event to a consumer; false when it failed and the consumer must wait. */
  private async deliver(state: ConsumerState, row: OutboxRow, sequence: bigint): Promise<boolean> {
    const { consumer } = state;
    const parsed = DomainEvent.safeParse(row.payload);
    if (!parsed.success) {
      // Retrying cannot repair a stored event; set it aside at once.
      await this.setAside(consumer, row, sequence, 'Stored event is not a valid domain event');
      return true;
    }
    const event = parsed.data;
    try {
      await this.prisma.transaction(async (tx) => {
        const [cursor] = await tx.$queryRaw<{ last_sequence: bigint }[]>`
          SELECT last_sequence FROM event_consumer_cursors
          WHERE consumer = ${consumer.name}
          FOR UPDATE`;
        // Another process (a restarting server) may have handled it meanwhile.
        if (cursor === undefined || cursor.last_sequence >= sequence) return;
        const { count } = await tx.inboxMessage.createMany({
          data: [
            {
              restaurantId: row.restaurantId,
              source: `consumer:${consumer.name}`,
              messageId: event.eventId,
              payload: { sequence: Number(sequence), type: event.type },
              processedAt: new Date(),
            },
          ],
          skipDuplicates: true,
        });
        if (count === 1) await consumer.handle(event, { tx, sequence: Number(sequence) });
        await tx.eventConsumerCursor.update({
          where: { consumer: consumer.name },
          data: { lastSequence: sequence, attempts: 0, lastError: null },
        });
      });
      state.retryAt = undefined;
      return true;
    } catch (error) {
      await this.recordFailure(state, row, sequence, error);
      return false;
    }
  }

  private async recordFailure(
    state: ConsumerState,
    row: OutboxRow,
    sequence: bigint,
    error: unknown,
  ): Promise<void> {
    const { consumer } = state;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
    try {
      const { attempts } = await this.prisma.eventConsumerCursor.update({
        where: { consumer: consumer.name },
        data: { attempts: { increment: 1 }, lastError: message },
        select: { attempts: true },
      });
      if (consumer.maxAttempts !== undefined && attempts >= consumer.maxAttempts) {
        await this.setAside(consumer, row, sequence, message);
        this.pending = true;
        return;
      }
      const delay = Math.min(
        this.options.retryMaxMs,
        this.options.retryBaseMs * 2 ** Math.min(attempts - 1, 30),
      );
      state.retryAt = Date.now() + delay;
      this.logger.warn(
        { consumer: consumer.name, sequence: sequence.toString(), attempts, err: error },
        'Event consumer failed; it will retry',
      );
    } catch (recordError) {
      state.retryAt = Date.now() + this.options.retryBaseMs;
      this.logger.error(
        { consumer: consumer.name, err: recordError },
        'Could not record an event consumer failure',
      );
    }
  }

  /** Records an event a consumer gave up on (the inbox keeps it with the error) and moves on. */
  private async setAside(
    consumer: EventConsumer,
    row: OutboxRow,
    sequence: bigint,
    reason: string,
  ): Promise<void> {
    const parsed = DomainEvent.safeParse(row.payload);
    await this.prisma.transaction(async (tx) => {
      await tx.inboxMessage.createMany({
        data: [
          {
            restaurantId: row.restaurantId,
            source: `consumer:${consumer.name}`,
            messageId: parsed.success ? parsed.data.eventId : `sequence:${sequence.toString()}`,
            payload: { sequence: Number(sequence), type: parsed.success ? parsed.data.type : null },
            lastError: reason,
          },
        ],
        skipDuplicates: true,
      });
      await tx.$executeRaw`
        UPDATE event_consumer_cursors
        SET last_sequence = GREATEST(last_sequence, ${sequence}), attempts = 0,
            last_error = ${`Set aside sequence ${sequence.toString()}: ${reason}`.slice(0, 1_000)},
            updated_at = now()
        WHERE consumer = ${consumer.name}`;
    });
    this.logger.error(
      { consumer: consumer.name, sequence: sequence.toString(), reason },
      'Event consumer gave up on an event; it is kept in the inbox',
    );
  }

  private async advance(consumer: string, sequence: bigint): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE event_consumer_cursors
      SET last_sequence = GREATEST(last_sequence, ${sequence}), updated_at = now()
      WHERE consumer = ${consumer}`;
  }

  private scheduleRetry(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.stopped) return;
    let next: number | undefined;
    for (const state of this.consumers.values()) {
      if (state.retryAt !== undefined && (next === undefined || state.retryAt < next)) {
        next = state.retryAt;
      }
    }
    if (next === undefined) return;
    this.retryTimer = setTimeout(
      () => {
        this.wake();
      },
      Math.max(0, next - Date.now()),
    );
    this.retryTimer.unref();
  }

  private async maxSequence(): Promise<number> {
    const { _max } = await this.prisma.outboxEvent.aggregate({ _max: { sequence: true } });
    return _max.sequence === null ? 0 : Number(_max.sequence);
  }

  private async ensureStreamId(): Promise<string> {
    await this.prisma.systemMeta.createMany({
      data: [{ key: STREAM_ID_KEY, value: randomUUID() }],
      skipDuplicates: true,
    });
    const row = await this.prisma.systemMeta.findUniqueOrThrow({ where: { key: STREAM_ID_KEY } });
    return row.value;
  }

  /** A dedicated connection that LISTENs for commits; reconnects with backoff when lost. */
  private async connectListener(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.config.databaseUrl, keepAlive: true });
    let lost = false;
    const onLost = (error?: unknown): void => {
      if (lost) return;
      lost = true;
      if (this.listener === client) this.listener = undefined;
      void client.end().catch(() => undefined);
      if (this.stopped) return;
      this.logger.warn({ err: error }, 'Lost the event notification connection; reconnecting');
      this.reconnectTimer = setTimeout(() => void this.connectListener(), this.listenerRetryMs);
      this.reconnectTimer.unref();
      this.listenerRetryMs = Math.min(this.listenerRetryMs * 2, 30_000);
    };
    client.on('notification', (message) => {
      if (message.channel === OUTBOX_CHANNEL) this.wake();
    });
    client.on('error', onLost);
    client.on('end', () => {
      onLost();
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${OUTBOX_CHANNEL}`);
      if (this.isStopped()) {
        await client.end();
        return;
      }
      this.listener = client;
      this.listenerRetryMs = 1_000;
      // Anything committed while nobody was listening.
      this.wake();
    } catch (error) {
      onLost(error);
    }
  }
}
