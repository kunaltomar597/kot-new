import type { KeyValueStore } from './storage.js';

/**
 * Submissions made while offline or while the server did not answer (WTR-012, ORD-013): kept on
 * the device with their idempotency key until the server has them. A retry with the same key never
 * creates a second order, so sending again is always safe. Nothing is dropped silently: a
 * submission the server refused stays, marked with the reason, until a person dismisses it.
 */

export type OutboxStatus = 'PENDING' | 'SENDING' | 'REJECTED';

export interface OutboxEntry<T = unknown> {
  /** The idempotency key the server de-duplicates by. */
  readonly key: string;
  /** What it is, e.g. "order", for the screen that lists unsent work. */
  readonly kind: string;
  readonly body: T;
  readonly createdAt: string;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly lastError: string | null;
}

/** What sending one entry came to. */
export type SendOutcome<T = never> =
  | { readonly kind: 'SENT' }
  /** No answer or a server error: try again later with the same key. */
  | { readonly kind: 'RETRY'; readonly error: string }
  /**
   * The server refused it (e.g. an item ran out): keep it for a person to fix or dismiss. `body`
   * replaces the stored one, e.g. with the refused lines marked.
   */
  | { readonly kind: 'REJECTED'; readonly reason: string; readonly body?: T };

export interface FlushResult {
  readonly sent: number;
  readonly retry: number;
  readonly rejected: number;
}

const STORAGE_KEY = 'rp.outbox.v1';

export class PersistentOutbox<T = unknown> {
  private entries: OutboxEntry<T>[] | undefined;
  private flushing: Promise<FlushResult> | undefined;
  private readonly listeners = new Set<(entries: readonly OutboxEntry<T>[]) => void>();

  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<readonly OutboxEntry<T>[]> {
    return [...(await this.load())];
  }

  /** Adds a submission; adding the same key again keeps the first (it is the same submission). */
  async enqueue(entry: { key: string; kind: string; body: T }): Promise<OutboxEntry<T>> {
    const entries = await this.load();
    const existing = entries.find((candidate) => candidate.key === entry.key);
    if (existing !== undefined) return existing;
    const added: OutboxEntry<T> = {
      ...entry,
      createdAt: this.now().toISOString(),
      status: 'PENDING',
      attempts: 0,
      lastError: null,
    };
    await this.save([...entries, added]);
    return added;
  }

  /** A person chose to drop a refused submission (it is never dropped otherwise). */
  async dismiss(key: string): Promise<void> {
    const entries = await this.load();
    await this.save(entries.filter((entry) => entry.key !== key || entry.status !== 'REJECTED'));
  }

  /** A refused submission was corrected: send it again (same key, new body). */
  async retry(key: string, body?: T): Promise<void> {
    const entries = await this.load();
    await this.save(
      entries.map((entry) =>
        entry.key === key
          ? { ...entry, ...(body !== undefined && { body }), status: 'PENDING', lastError: null }
          : entry,
      ),
    );
  }

  /**
   * Sends every pending entry, oldest first, one at a time (orders keep their order), including
   * entries added while it runs. Stops at the first RETRY: the network is down and later entries
   * would fail too. `only` leaves other entries waiting (e.g. another person's). One flush at a
   * time: a flush asked for while one runs joins it.
   */
  flush(
    send: (entry: OutboxEntry<T>) => Promise<SendOutcome<T>>,
    only: (entry: OutboxEntry<T>) => boolean = () => true,
  ): Promise<FlushResult> {
    this.flushing ??= this.run(send, only).finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  subscribe(listener: (entries: readonly OutboxEntry<T>[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async run(
    send: (entry: OutboxEntry<T>) => Promise<SendOutcome<T>>,
    only: (entry: OutboxEntry<T>) => boolean,
  ): Promise<FlushResult> {
    let sent = 0;
    let rejected = 0;
    let retry = 0;
    const tried = new Set<string>();
    for (;;) {
      const entry = (await this.load()).find(
        (candidate) =>
          candidate.status === 'PENDING' && !tried.has(candidate.key) && only(candidate),
      );
      if (entry === undefined) break;
      tried.add(entry.key);
      await this.replace(entry.key, { status: 'SENDING', attempts: entry.attempts + 1 });
      let outcome: SendOutcome<T>;
      try {
        outcome = await send(entry);
      } catch (error) {
        outcome = { kind: 'RETRY', error: error instanceof Error ? error.message : String(error) };
      }
      if (outcome.kind === 'SENT') {
        await this.save((await this.load()).filter((candidate) => candidate.key !== entry.key));
        sent += 1;
      } else if (outcome.kind === 'REJECTED') {
        await this.replace(entry.key, {
          status: 'REJECTED',
          lastError: outcome.reason,
          ...(outcome.body !== undefined && { body: outcome.body }),
        });
        rejected += 1;
      } else {
        await this.replace(entry.key, { status: 'PENDING', lastError: outcome.error });
        retry = (await this.load()).filter(
          (candidate) => candidate.status === 'PENDING' && only(candidate),
        ).length;
        break;
      }
    }
    return { sent, retry, rejected };
  }

  private async replace(key: string, change: Partial<OutboxEntry<T>>): Promise<void> {
    const entries = await this.load();
    await this.save(entries.map((entry) => (entry.key === key ? { ...entry, ...change } : entry)));
  }

  private async load(): Promise<OutboxEntry<T>[]> {
    if (this.entries !== undefined) return this.entries;
    const text = await this.store.getItem(STORAGE_KEY);
    let loaded: OutboxEntry<T>[] = [];
    if (text !== null) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) loaded = parsed as OutboxEntry<T>[];
      } catch {
        loaded = [];
      }
    }
    // A send cut short by the app closing is pending again (the key makes resending safe).
    this.entries = loaded.map((entry) =>
      entry.status === 'SENDING' ? { ...entry, status: 'PENDING' } : entry,
    );
    return this.entries;
  }

  private async save(entries: OutboxEntry<T>[]): Promise<void> {
    this.entries = entries;
    await this.store.setItem(STORAGE_KEY, JSON.stringify(entries));
    for (const listener of this.listeners) listener([...entries]);
  }
}
