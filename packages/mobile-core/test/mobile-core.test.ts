import type { LoginResponse, MenuSnapshot } from '@rp/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  createMobileClient,
  loadCredentials,
  MemoryStore,
  MenuCache,
  PersistentOutbox,
  type SendOutcome,
} from '../src/index.js';

const DEVICE_ID = '0199a0e0-0000-7000-8000-000000000001';
const STAFF_ID = '0199a0e0-0000-7000-8000-000000000002';
const ITEM_ID = '0199a0e0-0000-7000-8000-000000000003';
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

describe('[WTR-012] [ORD-013] the persistent outbox', () => {
  const order = (n: number) => ({ key: `key-${String(n)}`, kind: 'order', body: { n } });

  it('keeps submissions across restarts and sends them oldest first with their keys', async () => {
    const store = new MemoryStore();
    const first = new PersistentOutbox<{ n: number }>(store);
    await first.enqueue(order(1));
    await first.enqueue(order(2));
    // The same key again is the same submission.
    await first.enqueue({ ...order(1), body: { n: 99 } });
    const restarted = new PersistentOutbox<{ n: number }>(store);
    expect((await restarted.list()).map((entry) => entry.body.n)).toEqual([1, 2]);
    const sent: string[] = [];
    const result = await restarted.flush((entry) => {
      sent.push(entry.key);
      return Promise.resolve({ kind: 'SENT' });
    });
    expect(result).toEqual({ sent: 2, retry: 0, rejected: 0 });
    expect(sent).toEqual(['key-1', 'key-2']);
    expect(await new PersistentOutbox(store).list()).toEqual([]);
  });

  it('stops at the first failure to reach the server and tries again later with the same key', async () => {
    const outbox = new PersistentOutbox<{ n: number }>(new MemoryStore());
    await outbox.enqueue(order(1));
    await outbox.enqueue(order(2));
    const send = vi
      .fn<(entry: { key: string }) => Promise<SendOutcome>>()
      .mockRejectedValueOnce(new Error('Network down'))
      .mockResolvedValue({ kind: 'SENT' });
    expect(await outbox.flush(send)).toEqual({ sent: 0, retry: 2, rejected: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    const [waiting] = await outbox.list();
    expect(waiting).toMatchObject({
      key: 'key-1',
      status: 'PENDING',
      attempts: 1,
      lastError: 'Network down',
    });
    expect(await outbox.flush(send)).toEqual({ sent: 2, retry: 0, rejected: 0 });
    expect(send.mock.calls.map(([entry]) => entry.key)).toEqual(['key-1', 'key-1', 'key-2']);
  });

  it('never drops a refused submission until a person dismisses or corrects it', async () => {
    const outbox = new PersistentOutbox<{ n: number }>(new MemoryStore());
    await outbox.enqueue(order(1));
    await outbox.enqueue(order(2));
    const seen: number[] = [];
    outbox.subscribe((entries) => seen.push(entries.length));
    const result = await outbox.flush((entry) =>
      Promise.resolve(
        entry.key === 'key-1'
          ? { kind: 'REJECTED', reason: 'Paneer Tikka is out of stock' }
          : { kind: 'SENT' },
      ),
    );
    expect(result).toEqual({ sent: 1, retry: 0, rejected: 1 });
    expect(await outbox.list()).toMatchObject([
      { key: 'key-1', status: 'REJECTED', lastError: 'Paneer Tikka is out of stock' },
    ]);
    // Flushing again leaves it alone.
    await outbox.flush(() => Promise.resolve({ kind: 'SENT' }));
    expect(await outbox.list()).toHaveLength(1);
    // Corrected and sent again.
    await outbox.retry('key-1', { n: 10 });
    expect(await outbox.list()).toMatchObject([
      { status: 'PENDING', body: { n: 10 }, lastError: null },
    ]);
    await outbox.flush(() => Promise.resolve({ kind: 'REJECTED', reason: 'Still out' }));
    await outbox.dismiss('key-1');
    expect(await outbox.list()).toEqual([]);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('treats a send cut short by the app closing as pending, and runs one flush at a time', async () => {
    const store = new MemoryStore();
    await store.setItem(
      'rp.outbox.v1',
      JSON.stringify([
        { ...order(1), createdAt: 'x', status: 'SENDING', attempts: 1, lastError: null },
      ]),
    );
    const outbox = new PersistentOutbox<{ n: number }>(store);
    expect((await outbox.list())[0]?.status).toBe('PENDING');
    let release: (() => void) | undefined;
    const slow = () =>
      new Promise<SendOutcome>((resolve) => {
        release = () => {
          resolve({ kind: 'SENT' });
        };
      });
    const one = outbox.flush(slow);
    const two = outbox.flush(slow);
    await vi.waitFor(() => {
      expect(release).toBeDefined();
    });
    release?.();
    expect(await one).toBe(await two);
    await store.setItem('rp.outbox.v1', 'not json');
    expect(await new PersistentOutbox(store).list()).toEqual([]);
  });
});

function menu(version: number, available = true): MenuSnapshot {
  return {
    version,
    publishedAt: '2026-09-26T10:00:00.000Z',
    categories: [],
    items: [
      {
        id: ITEM_ID,
        categoryId: ITEM_ID,
        name: 'Paneer Tikka',
        basePrice: 28_000,
        taxGroupId: ITEM_ID,
        foodType: 'VEG',
        spiceLevel: 1,
        tags: [],
        stationId: ITEM_ID,
        available,
        stockCount: null,
        displayOrder: 1,
        channels: ['WAITER_APP'],
        variants: [],
        modifierGroupIds: [],
        synonyms: [],
        repeatable: false,
        archived: false,
      },
    ],
    modifierGroups: [],
    combos: [],
    taxGroups: [],
    stations: [],
  };
}

describe('[MENU-013] [MENU-006] the menu cache', () => {
  it('fetches once, keeps the menu offline and fetches again only for a newer version', async () => {
    const store = new MemoryStore();
    const cache = new MenuCache(store);
    expect(await cache.get()).toBeNull();
    const fetchMenu = vi.fn().mockResolvedValue(menu(3));
    expect((await cache.refresh(fetchMenu)).changed).toBe(true);
    expect((await cache.refresh(fetchMenu, { announcedVersion: 3 })).changed).toBe(false);
    expect(fetchMenu).toHaveBeenCalledTimes(1);

    // After a restart the menu is there without the server.
    expect((await new MenuCache(store).get())?.version).toBe(3);

    fetchMenu.mockResolvedValue(menu(4));
    expect(await cache.refresh(fetchMenu, { announcedVersion: 4 })).toMatchObject({
      changed: true,
    });
    expect((await cache.get())?.version).toBe(4);
    // A reconnect checks again even without an announcement; the same menu is not a change.
    expect((await cache.refresh(fetchMenu, { force: true })).changed).toBe(false);
  });

  it('applies availability changes, and ignores a damaged cache', async () => {
    const store = new MemoryStore();
    const cache = new MenuCache(store);
    expect(
      await cache.applyAvailability({ itemId: ITEM_ID, available: false, stockCount: 0 }),
    ).toBeNull();
    await cache.refresh(() => Promise.resolve(menu(1)));
    const updated = await cache.applyAvailability({
      itemId: ITEM_ID,
      available: false,
      stockCount: 0,
    });
    expect(updated?.items[0]).toMatchObject({ available: false, stockCount: 0 });
    await cache.clear();
    expect(await cache.get()).toBeNull();
    await store.setItem('rp.menu.v1', '{"version":"nope"}');
    expect(await new MenuCache(store).get()).toBeNull();
  });
});

describe('[AUTH-007] [SEC-010] credentials in the secure store', () => {
  const session: LoginResponse = {
    accessToken: 'access-1',
    accessTokenExpiresAt: inMinutes(15),
    refreshToken: 'refresh-token-number-1',
    session: {
      id: '0199a0e0-0000-7000-8000-000000000004',
      expiresAt: inMinutes(600),
      inactivityTimeoutSeconds: 600,
    },
    staff: { id: STAFF_ID, displayName: 'Ravi', role: 'WAITER' },
    secondFactorValidUntil: null,
  };

  it('restores the pairing, and writes every change back', async () => {
    const secure = new MemoryStore();
    await secure.setItem(
      'rp.credentials.v1',
      JSON.stringify({
        device: {
          deviceId: DEVICE_ID,
          deviceToken: 'device-1',
          deviceTokenExpiresAt: inMinutes(60),
        },
      }),
    );
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify(session), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const client = await createMobileClient({
      baseUrl: 'http://pos.test:8080',
      secureStore: secure,
      fetch: fetchMock,
    });
    expect(client.credentials.device?.deviceId).toBe(DEVICE_ID);
    await client.signInWithPin({ staffId: STAFF_ID, pin: '4444' });
    await vi.waitFor(async () => {
      expect((await loadCredentials(secure))?.session?.staff.id).toBe(STAFF_ID);
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get('x-device-token')).toBe('device-1');
  });

  it('starts empty on a fresh install and ignores damaged storage', async () => {
    const secure = new MemoryStore();
    expect(await loadCredentials(secure)).toBeNull();
    await secure.setItem('rp.credentials.v1', '"just text"');
    expect(await loadCredentials(secure)).toBeNull();
    const client = await createMobileClient({ baseUrl: 'http://pos.test', secureStore: secure });
    expect(client.credentials).toEqual({});
  });
});
