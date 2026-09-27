import { ApiContractError, ApiRequestError, type TypedApi } from '@rp/api-client';
import type { SubmitOrderRequest, SubmitOrderResponse } from '@rp/contracts';
import type { CartLine } from '@rp/ordering';
import {
  type FlushResult,
  type OutboxEntry,
  PersistentOutbox,
  type SendOutcome,
} from './outbox.js';
import type { KeyValueStore } from './storage.js';

/** The server took the order: its number, and whether this key had been seen before. */
export type AcceptedOrder = Extract<SubmitOrderResponse, { status: 'ACCEPTED' }>;

type RejectedLine = Extract<
  SubmitOrderResponse,
  { status: 'PARTIALLY_REJECTED' }
>['rejectedLines'][number];

/**
 * Why the server refused a draft: some of its lines (ORD-017, e.g. sold out), or the whole order
 * with the server's plain-language message (e.g. the table was closed meanwhile).
 */
export type DraftProblem =
  | { readonly kind: 'LINES'; readonly lines: readonly RejectedLine[] }
  | { readonly kind: 'REFUSED'; readonly code: string; readonly message: string };

/**
 * An order on its way to the server (WTR-012): the request exactly as it is sent, with its
 * idempotency key, and the lines as the person chose them, to show while it waits and to put
 * back in the cart if the server refuses it.
 */
export interface OrderDraft {
  /**
   * Who took it: it is sent only while they are signed in, so it goes in their name. Null on a
   * device without staff sign-in (the table tablet).
   */
  readonly staffId: string | null;
  /** The table's name when it was taken, for the list of unsent orders. */
  readonly tableLabel: string;
  readonly request: SubmitOrderRequest;
  readonly lines: readonly CartLine[];
  readonly problem?: DraftProblem;
}

/** What sending a new order came to, for the screen that sent it. */
export type OrderSendResult =
  | { readonly status: 'SENT'; readonly order: AcceptedOrder }
  /** No answer: kept on the device and sent again on reconnect with the same key. */
  | { readonly status: 'QUEUED' }
  | { readonly status: 'REJECTED'; readonly problem: DraftProblem };

/** An order the server took, and whether it went while nobody waited on it (a later resend). */
export interface SentOrder {
  readonly draft: OrderDraft;
  readonly order: AcceptedOrder;
  readonly background: boolean;
}

/** A refusal the person must see; anything else is tried again later with the same key. */
function isRefusal(error: ApiRequestError): boolean {
  return (
    error.status >= 400 &&
    error.status < 500 &&
    // The session ended (sign in again), a timeout or too many requests: not about the order.
    ![401, 408, 429].includes(error.status)
  );
}

/**
 * Orders from this device on their way to the kitchen (WTR-012, ORD-013). Every order is kept on
 * the device before it is sent, so an order made offline, or whose answer was lost, is sent again
 * on reconnect with the same idempotency key and the server never makes it twice. Orders go only
 * while the person who took them is signed in. A refused order stays, with the reason, until the
 * person changes it or throws it away.
 */
export class OrderOutbox {
  private readonly outbox: PersistentOutbox<OrderDraft>;
  /** Keys a `submit` is waiting on, and what the server answered for them. */
  private readonly awaiting = new Set<string>();
  private readonly accepted = new Map<string, AcceptedOrder>();
  private readonly sentListeners = new Set<(sent: SentOrder) => void>();

  constructor(
    private readonly options: {
      readonly store: KeyValueStore;
      readonly api: () => TypedApi;
      /** Who is signed in now, or null. */
      readonly staffId: () => string | null;
      readonly now?: () => Date;
    },
  ) {
    this.outbox = new PersistentOutbox<OrderDraft>(options.store, options.now);
  }

  /** Every unsent order, oldest first, whoever took it. */
  list(): Promise<readonly OutboxEntry<OrderDraft>[]> {
    return this.outbox.list();
  }

  subscribe(listener: (entries: readonly OutboxEntry<OrderDraft>[]) => void): () => void {
    return this.outbox.subscribe(listener);
  }

  /** Called for every order the server takes, including ones sent again later. */
  onSent(listener: (sent: SentOrder) => void): () => void {
    this.sentListeners.add(listener);
    return () => {
      this.sentListeners.delete(listener);
    };
  }

  /**
   * Keeps the order on the device, then sends it (after any older unsent order of the same
   * person). Never throws for the network: an unanswered order is QUEUED.
   */
  async submit(draft: OrderDraft): Promise<OrderSendResult> {
    const key = draft.request.idempotencyKey;
    this.awaiting.add(key);
    try {
      await this.outbox.enqueue({ key, kind: 'order', body: draft });
      await this.flush();
      const order = this.accepted.get(key);
      if (order !== undefined) return { status: 'SENT', order };
      const entry = (await this.outbox.list()).find((candidate) => candidate.key === key);
      if (entry?.status === 'REJECTED' && entry.body.problem !== undefined) {
        return { status: 'REJECTED', problem: entry.body.problem };
      }
      return { status: 'QUEUED' };
    } finally {
      this.awaiting.delete(key);
      this.accepted.delete(key);
    }
  }

  /** Sends the signed-in person's unsent orders, oldest first (on reconnect, or on request). */
  flush(): Promise<FlushResult> {
    return this.outbox.flush(
      (entry) => this.send(entry),
      (entry) => entry.body.staffId === this.options.staffId(),
    );
  }

  /**
   * Takes a refused order off the device to be changed and sent as a new order (its lines go
   * back into the cart); undefined when there is no such refused order.
   */
  async takeBack(key: string): Promise<OrderDraft | undefined> {
    const entry = (await this.outbox.list()).find((candidate) => candidate.key === key);
    if (entry?.status !== 'REJECTED') return undefined;
    await this.outbox.dismiss(key);
    return entry.body;
  }

  /** The person throws a refused order away (it is never dropped otherwise). */
  dismiss(key: string): Promise<void> {
    return this.outbox.dismiss(key);
  }

  private async send(entry: OutboxEntry<OrderDraft>): Promise<SendOutcome<OrderDraft>> {
    let response: SubmitOrderResponse;
    try {
      response = await this.options.api().submitOrder({ body: entry.body.request });
    } catch (error) {
      if (error instanceof ApiRequestError && isRefusal(error)) {
        return this.refused(entry, { kind: 'REFUSED', code: error.code, message: error.message });
      }
      if (error instanceof ApiContractError) {
        // The request or answer does not fit the contract: sending it again cannot help.
        return this.refused(entry, {
          kind: 'REFUSED',
          code: 'CONTRACT_ERROR',
          message: error.message,
        });
      }
      throw error;
    }
    if (response.status === 'PARTIALLY_REJECTED') {
      return this.refused(entry, { kind: 'LINES', lines: response.rejectedLines });
    }
    if (this.awaiting.has(entry.key)) this.accepted.set(entry.key, response);
    const sent: SentOrder = {
      draft: entry.body,
      order: response,
      background: !this.awaiting.has(entry.key),
    };
    for (const listener of this.sentListeners) listener(sent);
    return { kind: 'SENT' };
  }

  private refused(entry: OutboxEntry<OrderDraft>, problem: DraftProblem): SendOutcome<OrderDraft> {
    return {
      kind: 'REJECTED',
      reason: problem.kind === 'LINES' ? 'LINES_REJECTED' : problem.code,
      body: { ...entry.body, problem },
    };
  }
}
