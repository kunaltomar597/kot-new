import {
  type DomainEvent,
  REALTIME_MESSAGES,
  REALTIME_NAMESPACE,
  REALTIME_PATH,
  RealtimeEnded,
  RealtimeEvent,
  RealtimeHead,
  RealtimeSync,
} from '@rp/contracts';
import { io, type Socket } from 'socket.io-client';
import { until } from './wait.js';

const DEFAULT_TIMEOUT_MS = 5_000;

/** A `connect_error` as the client sees it. */
export interface ConnectFailure {
  readonly message: string;
  readonly code: string | undefined;
}

function openSocket(url: string, auth: Record<string, unknown>, namespace: string): Socket {
  return io(`${url}${namespace}`, {
    path: REALTIME_PATH,
    transports: ['websocket'],
    auth,
    forceNew: true,
    reconnection: false,
    timeout: DEFAULT_TIMEOUT_MS,
  });
}

function failureOf(error: Error & { data?: unknown }): ConnectFailure {
  const data = error.data as { code?: unknown } | undefined;
  return {
    message: error.message,
    code: typeof data?.code === 'string' ? data.code : undefined,
  };
}

/**
 * A Socket.io client of the `/rt` namespace for integration tests (P0-12): it records every
 * message the server sends, checked against the contracts, and waits for conditions.
 */
export class RealtimeTestClient {
  readonly events: RealtimeEvent[] = [];
  readonly syncs: RealtimeSync[] = [];
  readonly heads: RealtimeHead[] = [];
  readonly endings: RealtimeEnded[] = [];
  /** How many events had arrived when each `sync` arrived (replayed events come first). */
  readonly eventsAtSync: number[] = [];
  disconnectReason: string | undefined;

  private constructor(readonly socket: Socket) {
    socket.on(REALTIME_MESSAGES.event, (message: unknown) => {
      this.events.push(RealtimeEvent.parse(message));
    });
    socket.on(REALTIME_MESSAGES.sync, (message: unknown) => {
      this.syncs.push(RealtimeSync.parse(message));
      this.eventsAtSync.push(this.events.length);
    });
    socket.on(REALTIME_MESSAGES.head, (message: unknown) => {
      this.heads.push(RealtimeHead.parse(message));
    });
    socket.on(REALTIME_MESSAGES.ended, (message: unknown) => {
      this.endings.push(RealtimeEnded.parse(message));
    });
    socket.on('disconnect', (reason) => {
      this.disconnectReason = reason;
    });
  }

  /** Connects and waits for the first `sync`; rejects with the server's refusal. */
  static async connect(url: string, auth: Record<string, unknown>): Promise<RealtimeTestClient> {
    const client = new RealtimeTestClient(openSocket(url, auth, REALTIME_NAMESPACE));
    await new Promise<void>((resolve, reject) => {
      client.socket.once('connect_error', (error: Error & { data?: unknown }) => {
        const failure = failureOf(error);
        reject(new Error(`Connection refused: ${failure.code ?? failure.message}`));
      });
      client.socket.once('connect', () => {
        resolve();
      });
    });
    await client.waitFor(() => client.syncs[0]);
    return client;
  }

  /** Expects the server to refuse the connection and returns why. */
  static refused(
    url: string,
    auth: Record<string, unknown>,
    namespace: string = REALTIME_NAMESPACE,
  ): Promise<ConnectFailure> {
    const socket = openSocket(url, auth, namespace);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('Neither refused nor connected'));
      }, DEFAULT_TIMEOUT_MS);
      socket.once('connect_error', (error: Error & { data?: unknown }) => {
        clearTimeout(timer);
        socket.close();
        resolve(failureOf(error));
      });
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.close();
        reject(new Error('The server accepted the connection'));
      });
    });
  }

  /** The highest sequence seen, as a device stores it to resume from (NFR-P11). */
  get lastSequence(): number {
    return Math.max(
      0,
      ...this.events.map((message) => message.sequence),
      ...this.syncs.map((sync) => sync.head),
      ...this.heads.map((head) => head.head),
    );
  }

  /** The domain events received, in order. */
  get received(): DomainEvent[] {
    return this.events.map((message) => message.event);
  }

  /** Polls `find` until it returns a value (not undefined/false) or the timeout passes. */
  waitFor<T>(
    find: () => T | undefined | false,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    return until(find, timeoutMs, 'the real-time client');
  }

  /** Waits for an event with this id. */
  waitForEvent(eventId: string, timeoutMs?: number): Promise<RealtimeEvent> {
    return this.waitFor(
      () => this.events.find((message) => message.event.eventId === eventId),
      timeoutMs,
    );
  }

  /** Waits until the server closes the connection; returns the socket's reason. */
  waitForDisconnect(timeoutMs?: number): Promise<string> {
    return this.waitFor(() => this.disconnectReason, timeoutMs);
  }

  async resync(request: unknown): Promise<RealtimeSync> {
    return RealtimeSync.parse(
      await this.socket.timeout(DEFAULT_TIMEOUT_MS).emitWithAck(REALTIME_MESSAGES.resync, request),
    );
  }

  close(): void {
    this.socket.close();
  }
}
