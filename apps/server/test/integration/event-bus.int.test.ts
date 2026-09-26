import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { DomainEvent } from '@rp/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CONFIG, type AppConfig } from '../../src/config/app-config.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import {
  type ConsumerContext,
  DEFAULT_EVENT_BUS_OPTIONS,
  EVENT_BUS_OPTIONS,
  EventBus,
  type EventBusOptions,
  type EventConsumer,
  type PublishedEvent,
} from '../../src/events/event-bus.js';
import { appendEvent } from '../../src/events/outbox.js';
import { domainEvent, produce } from '../helpers/events.js';
import { createTestApp } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';
import { until } from '../helpers/wait.js';

/** Records what it handled; fails a chosen number of times per event first. */
class ProbeConsumer implements EventConsumer {
  readonly name = 'test.probe';
  readonly types = ['OrderSubmitted', 'KotCreated'] as const;
  readonly handled: string[] = [];
  readonly failuresLeft = new Map<string, number>();

  async handle(event: DomainEvent, context: ConsumerContext): Promise<void> {
    // A database effect in the consumer's transaction: it must happen exactly once.
    await context.tx.systemMeta.create({
      data: { key: `probe:${event.eventId}`, value: String(context.sequence) },
    });
    const left = this.failuresLeft.get(event.eventId) ?? 0;
    if (left > 0) {
      this.failuresLeft.set(event.eventId, left - 1);
      throw new Error('Kitchen printer is offline');
    }
    this.handled.push(event.eventId);
  }
}

/** Gives up on "poison" events after two attempts. */
class GivingUpConsumer implements EventConsumer {
  readonly name = 'test.gives-up';
  readonly types = ['OrderRejected'] as const;
  readonly maxAttempts = 2;
  readonly handled: string[] = [];
  readonly attempts = new Map<string, number>();

  handle(event: DomainEvent): Promise<void> {
    this.attempts.set(event.eventId, (this.attempts.get(event.eventId) ?? 0) + 1);
    if (event.type === 'OrderRejected' && event.payload.reason === 'poison') {
      return Promise.reject(new Error('poison event'));
    }
    this.handled.push(event.eventId);
    return Promise.resolve();
  }
}

const FAST: EventBusOptions = {
  ...DEFAULT_EVENT_BUS_OPTIONS,
  // Notifications must do the waking: the poll is too slow to matter within a test.
  pollIntervalMs: 60_000,
  retryBaseMs: 20,
  retryMaxMs: 100,
};

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let bus: EventBus;
const probe = new ProbeConsumer();
const givingUp = new GivingUpConsumer();
const restaurantId = randomUUID();

function orderSubmitted(orderNumber = 1) {
  return domainEvent('OrderSubmitted', restaurantId, {
    orderId: randomUUID(),
    orderNumber,
    source: 'POS',
    needsApproval: false,
  });
}

function orderRejected(reason: string) {
  return domainEvent('OrderRejected', restaurantId, {
    orderId: randomUUID(),
    rejectedBy: randomUUID(),
    reason,
  });
}

async function sequencesAfter(after: number): Promise<number[]> {
  const rows = await prisma.outboxEvent.findMany({
    where: { sequence: { gt: BigInt(after) } },
    orderBy: { sequence: 'asc' },
    select: { sequence: true },
  });
  return rows.map((row) => Number(row.sequence));
}

async function maxSequence(): Promise<number> {
  const { _max } = await prisma.outboxEvent.aggregate({ _max: { sequence: true } });
  return Number(_max.sequence ?? 0n);
}

async function cursorOf(consumer: string) {
  return prisma.eventConsumerCursor.findUniqueOrThrow({ where: { consumer } });
}

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    overrides: [{ provide: EVENT_BUS_OPTIONS, useValue: FAST }],
    beforeInit: (created) => {
      created.get(EventBus).subscribe(probe);
      created.get(EventBus).subscribe(givingUp);
    },
  });
  prisma = app.get(PrismaService);
  bus = app.get(EventBus);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('[INT-004] [BRD 10.1] transactional outbox numbering', () => {
  it('numbers committed events gap-free, keeping each transaction’s order, under concurrency', async () => {
    const before = bus.head;
    const batches = Array.from({ length: 10 }, (_, index) => [
      orderSubmitted(index * 3 + 1),
      orderSubmitted(index * 3 + 2),
      orderSubmitted(index * 3 + 3),
    ]);
    const rolledBack = orderSubmitted(999);
    await Promise.all([
      ...batches.map((events) => produce(app, events)),
      prisma
        .transaction(async (tx) => {
          await appendEvent(tx, rolledBack, { aggregate: { type: 'test', id: randomUUID() } });
          throw new Error('The order could not be saved');
        })
        .catch(() => undefined),
    ]);
    await bus.drain();

    // Gap-free: a client that saw sequence N has seen everything before N.
    expect(await sequencesAfter(before)).toEqual(
      Array.from({ length: 30 }, (_, index) => before + index + 1),
    );
    const rows = await prisma.outboxEvent.findMany({
      where: { sequence: { gt: BigInt(before) } },
      select: { sequence: true, payload: true },
    });
    const sequenceOf = new Map(
      rows.map((row) => [(row.payload as { eventId: string }).eventId, Number(row.sequence)]),
    );
    for (const events of batches) {
      const sequences = events.map((event) => sequenceOf.get(event.eventId) ?? 0);
      expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    }
    // A rolled-back change leaves no event behind.
    expect(sequenceOf.has(rolledBack.eventId)).toBe(false);
    expect(bus.head).toBe(before + 30);
  });

  it('[NFR-P11] wakes on commit and publishes within a second, without polling', async () => {
    const received: PublishedEvent[] = [];
    const off = bus.onPublished((events) => {
      received.push(...events);
    });
    try {
      const event = domainEvent('MenuPublished', restaurantId, { menuVersion: 4 });
      const started = performance.now();
      await produce(app, [event]);
      const published = await until(
        () => received.find((item) => item.event.eventId === event.eventId),
        2_000,
        'the published event',
      );
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(published.sequence).toBe(bus.head);
    } finally {
      off();
    }
  });

  it('keeps delivering to other listeners when one throws', async () => {
    const received: string[] = [];
    const offBroken = bus.onPublished(() => {
      throw new Error('listener bug');
    });
    const offGood = bus.onPublished((events) => {
      received.push(...events.map((item) => item.event.eventId));
    });
    try {
      const event = domainEvent('MenuPublished', restaurantId, { menuVersion: 5 });
      await produce(app, [event]);
      await until(() => received.includes(event.eventId), 2_000, 'the healthy listener');
    } finally {
      offBroken();
      offGood();
    }
  });

  it('attaches the producer’s audience hints to published events', async () => {
    const received: PublishedEvent[] = [];
    const off = bus.onPublished((events) => {
      received.push(...events);
    });
    try {
      const tableId = randomUUID();
      const event = domainEvent('BillRequested', restaurantId, {
        tableSessionId: randomUUID(),
        requestedFrom: 'TABLE_TABLET',
      });
      await produce(app, [event], { tableIds: [tableId] });
      const published = await until(() =>
        received.find((item) => item.event.eventId === event.eventId),
      );
      expect(published.audience).toEqual({ tableIds: [tableId] });
    } finally {
      off();
    }
  });
});

describe('[NTF-006] durable consumers: at least once, never lost, never twice', () => {
  it('retries a failing consumer with backoff; later events wait and nothing is lost', async () => {
    const [first, second, third] = [orderSubmitted(), orderSubmitted(), orderSubmitted()];
    probe.failuresLeft.set(second.eventId, 2);
    await produce(app, [first, second, third]);

    await until(() => probe.handled.includes(third.eventId), 5_000, 'the retried consumer');
    // `handled` is recorded inside the consumer's transaction; let it commit before counting.
    await bus.drain();
    const ids = [first, second, third].map((event) => event.eventId);
    expect(probe.handled.filter((id) => ids.includes(id))).toEqual(ids);
    // The failed attempts rolled back their writes: one effect per event.
    expect(
      await prisma.systemMeta.count({ where: { key: { in: ids.map((id) => `probe:${id}`) } } }),
    ).toBe(3);
    const cursor = await cursorOf(probe.name);
    expect(cursor.attempts).toBe(0);
    expect(cursor.lastError).toBeNull();
  });

  it('skips redelivered events through the inbox (idempotent consumer)', async () => {
    const event = orderSubmitted();
    await produce(app, [event]);
    await until(() => probe.handled.includes(event.eventId));
    const handledBefore = probe.handled.length;

    // As if the server had crashed after handling but before saving the cursor.
    await prisma.eventConsumerCursor.update({
      where: { consumer: probe.name },
      data: { lastSequence: 0n },
    });
    await bus.drain();

    expect(probe.handled).toHaveLength(handledBefore);
    expect(new Set(probe.handled).size).toBe(probe.handled.length);
    expect(Number((await cursorOf(probe.name)).lastSequence)).toBe(bus.head);
    expect(
      await prisma.inboxMessage.count({
        where: { source: `consumer:${probe.name}`, messageId: event.eventId },
      }),
    ).toBe(1);
  });

  it('sets an event aside after maxAttempts, keeps it in the inbox and moves on', async () => {
    const poison = orderRejected('poison');
    const next = orderRejected('Item finished');
    await produce(app, [poison, next]);

    await until(() => givingUp.handled.includes(next.eventId), 5_000, 'the next event');
    expect(givingUp.attempts.get(poison.eventId)).toBe(2);
    const aside = await prisma.inboxMessage.findFirstOrThrow({
      where: { source: `consumer:${givingUp.name}`, messageId: poison.eventId },
    });
    expect(aside.processedAt).toBeNull();
    expect(aside.lastError).toMatch(/poison/);
  });

  it('sets an unreadable stored event aside at once', async () => {
    const id = randomUUID();
    await prisma.$executeRaw`
      INSERT INTO outbox (id, restaurant_id, event_type, aggregate_type, aggregate_id, payload)
      VALUES (${id}::uuid, ${restaurantId}::uuid, 'KotCreated', 'test', ${randomUUID()}::uuid,
              '{"broken": true}'::jsonb)`;
    await bus.drain();
    const { sequence } = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
    const aside = await until(
      async () =>
        (await prisma.inboxMessage.findFirst({
          where: { source: `consumer:${probe.name}`, messageId: `sequence:${String(sequence)}` },
        })) ?? undefined,
    );
    expect(aside.lastError).toMatch(/not a valid domain event/);
    expect((await cursorOf(probe.name)).lastSequence).toBe(sequence);
  });
});

describe('several dispatchers on one database (a restarting server)', () => {
  let second: INestApplication;

  beforeAll(async () => {
    second = await createTestApp({
      databaseUrl: database.url,
      // No notifications: this one relies on polling alone.
      overrides: [
        {
          provide: EVENT_BUS_OPTIONS,
          useValue: { ...DEFAULT_EVENT_BUS_OPTIONS, listen: false, pollIntervalMs: 50 },
        },
      ],
    });
  });

  afterAll(async () => {
    await second.close();
  });

  it('shares the stream id, which survives restarts', () => {
    expect(second.get(EventBus).streamId).toBe(bus.streamId);
    expect(bus.streamId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('never reuses or skips a number, and a polling dispatcher still publishes', async () => {
    const before = await maxSequence();
    const received: string[] = [];
    const off = second.get(EventBus).onPublished((events) => {
      received.push(...events.map((item) => item.event.eventId));
    });
    try {
      const events = Array.from({ length: 12 }, (_, index) => orderSubmitted(index + 1));
      await Promise.all(
        events.map((event, index) => produce(index % 2 === 0 ? app : second, [event])),
      );
      await until(
        () => events.every((event) => received.includes(event.eventId)),
        5_000,
        'the polling dispatcher',
      );
      expect(await sequencesAfter(before)).toEqual(
        Array.from({ length: 12 }, (_, index) => before + index + 1),
      );
    } finally {
      off();
    }
  });
});

describe('outbox clean-up', () => {
  it('keeps everything that is still recent', async () => {
    const before = await prisma.outboxEvent.count();
    expect(before).toBeGreaterThan(1);
    expect(await bus.cleanup()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(before);
  });

  it('drops old events every consumer has handled, keeping the newest so numbers never restart', async () => {
    await produce(app, [orderSubmitted(), orderSubmitted(), orderSubmitted(), orderSubmitted()]);
    await bus.drain();
    const head = bus.head;
    await until(async () => Number((await cursorOf(probe.name)).lastSequence) === head);
    // Only the probe's cursor matters here; the application's own consumers are past everything.
    await prisma.eventConsumerCursor.updateMany({
      where: { consumer: { not: probe.name } },
      data: { lastSequence: BigInt(head) },
    });
    await prisma.$executeRaw`UPDATE outbox SET published_at = now() - interval '2 days'`;
    await prisma.$executeRaw`UPDATE inbox SET received_at = now() - interval '2 days'`;

    // A consumer that is behind holds back what it still needs.
    await prisma.eventConsumerCursor.update({
      where: { consumer: probe.name },
      data: { lastSequence: BigInt(head - 3) },
    });
    await bus.cleanup();
    expect(await bus.oldestRetained()).toBe(head - 2);

    await prisma.eventConsumerCursor.update({
      where: { consumer: probe.name },
      data: { lastSequence: BigInt(head) },
    });
    await bus.cleanup();
    expect(await sequencesAfter(0)).toEqual([head]);
    // Handled inbox records went too; set-aside ones stay for diagnosis.
    expect(await prisma.inboxMessage.count({ where: { processedAt: { not: null } } })).toBe(0);
    expect(await prisma.inboxMessage.count({ where: { processedAt: null } })).toBeGreaterThan(0);

    const event = orderSubmitted();
    await produce(app, [event]);
    await bus.drain();
    expect(await sequencesAfter(head)).toEqual([head + 1]);
  });
});

describe('consumer registration', () => {
  it('is refused after start-up, for bad names, duplicates and maxAttempts below one', () => {
    const consumer: EventConsumer = {
      name: 'test.late',
      types: ['MenuPublished'],
      handle: () => Promise.resolve(),
    };
    expect(() => {
      bus.subscribe(consumer);
    }).toThrow(/after start-up/);

    const fresh = new EventBus(prisma, app.get<AppConfig>(APP_CONFIG), DEFAULT_EVENT_BUS_OPTIONS);
    expect(() => {
      fresh.subscribe({ ...consumer, name: 'Bad Name' });
    }).toThrow(/Invalid consumer name/);
    fresh.subscribe(consumer);
    expect(() => {
      fresh.subscribe(consumer);
    }).toThrow(/already subscribed/);
    expect(() => {
      fresh.subscribe({ ...consumer, name: 'test.zero', maxAttempts: 0 });
    }).toThrow(/maxAttempts/);
    // Not started: waking does nothing.
    fresh.wake();
    expect(fresh.head).toBe(0);
  });
});
