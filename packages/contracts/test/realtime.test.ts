import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  REALTIME_MESSAGES,
  REALTIME_NAMESPACE,
  RealtimeEndReason,
  RealtimeEvent,
  RealtimeHandshake,
  RealtimeResyncRequest,
  RealtimeSync,
} from '../src/index.js';

const menuPublished = {
  eventId: randomUUID(),
  type: 'MenuPublished',
  version: 1,
  occurredAt: '2026-09-25T10:00:00.000Z',
  restaurantId: randomUUID(),
  businessDate: '2026-09-25',
  payload: { menuVersion: 3 },
};

describe('[NFR-P11] [NTF-006] real-time protocol contracts', () => {
  it('names the namespace and messages clients rely on', () => {
    expect(REALTIME_NAMESPACE).toBe('/rt');
    expect(Object.values(REALTIME_MESSAGES)).toEqual(['event', 'sync', 'head', 'resync', 'ended']);
  });

  it('requires a device token in the handshake; the person and resume point are optional', () => {
    expect(RealtimeHandshake.safeParse({}).success).toBe(false);
    expect(RealtimeHandshake.safeParse({ deviceToken: '' }).success).toBe(false);
    expect(RealtimeHandshake.parse({ deviceToken: 'abc' })).toEqual({ deviceToken: 'abc' });
    const resume = { deviceToken: 'abc', lastSequence: 42, streamId: randomUUID() };
    expect(RealtimeHandshake.parse(resume)).toEqual(resume);
    expect(RealtimeHandshake.safeParse({ ...resume, lastSequence: -1 }).success).toBe(false);
    expect(RealtimeHandshake.safeParse({ ...resume, lastSequence: 1.5 }).success).toBe(false);
    expect(RealtimeHandshake.safeParse({ ...resume, streamId: 'not-a-uuid' }).success).toBe(false);
  });

  it('carries a domain event with its positive sequence', () => {
    expect(RealtimeEvent.parse({ sequence: 1, event: menuPublished }).event.type).toBe(
      'MenuPublished',
    );
    expect(RealtimeEvent.safeParse({ sequence: 0, event: menuPublished }).success).toBe(false);
    expect(
      RealtimeEvent.safeParse({ sequence: 2, event: { ...menuPublished, type: 'Unknown' } })
        .success,
    ).toBe(false);
  });

  it('describes sync, resync and why a connection ended', () => {
    const sync = { streamId: randomUUID(), head: 10, replayed: 2, fullRefresh: false };
    expect(RealtimeSync.parse(sync)).toEqual(sync);
    expect(RealtimeResyncRequest.safeParse({ lastSequence: -2 }).success).toBe(false);
    expect(RealtimeEndReason.options).toEqual([
      'DEVICE_REVOKED',
      'DEVICE_CHANGED',
      'SESSION_ENDED',
    ]);
  });
});
