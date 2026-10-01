import type { RelaySessionResponse } from '@rp/contracts/relay';
import { RelayError } from './relay-client.js';

/** The one channel a local server joins: its doorbell for new QR orders and requests. */
const TOPIC = 'realtime:rp-qr-doorbell';

export interface RelayRealtimeOptions {
  /** The relay's functions address (`RP_RELAY_URL`); Realtime is on the same host. */
  readonly relayUrl: string;
  /** A fresh Realtime session, or undefined when the relay is not set up here (no credential). */
  readonly session: () => Promise<RelaySessionResponse | undefined>;
  /** Something new is waiting at the relay: pick it up. */
  readonly onRing: () => void;
  /** The doorbell started or stopped working (polling speeds up while it does not). */
  readonly onChange: (subscribed: boolean) => void;
  /** Phoenix heartbeat; a heartbeat still unanswered at the next one means the line is dead. */
  readonly heartbeatMs: number;
  /** Renew the token this long before it runs out. */
  readonly refreshBeforeMs: number;
  /** After a failure: this, doubling per failure, up to `retryMaxMs`. */
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  /** When the relay has no Realtime (no JWT secret), ask again this much later. */
  readonly notConfiguredRetryMs: number;
  /** Replaces the global WebSocket (tests). */
  readonly WebSocket?: typeof WebSocket;
}

interface PhoenixMessage {
  readonly topic?: unknown;
  readonly event?: unknown;
  readonly payload?: unknown;
  readonly ref?: unknown;
}

/** Realtime's socket address on the relay's host, with the public API key it asks for. */
export function realtimeUrlOf(relayUrl: string, apiKey: string): string {
  const url = new URL('/realtime/v1/websocket', relayUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('apikey', apiKey);
  url.searchParams.set('vsn', '1.0.0');
  return url.toString();
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/**
 * The QR relay's doorbell (P5-03d, QR-009, ADR-0015): a Supabase Realtime subscription to this
 * restaurant's new QR orders and service requests, so they are picked up within a second while
 * polling slows down to a safety net. It only rings; what is new is always read through the
 * `server` function, the one trusted way in. It speaks Realtime's Phoenix protocol (1.0.0, JSON)
 * over Node's WebSocket: join with the session's token, heartbeats, the token renewed before it
 * runs out, and a fresh join with back-off whenever the line drops. Without Realtime at the relay
 * it stays off and polling carries on (NFR-A01: in-restaurant work never waits on it).
 */
export class RelayRealtime {
  private readonly WebSocket: typeof WebSocket;
  private socket: WebSocket | undefined;
  private live = false;
  private stopped = true;
  private failures = 0;
  private nextRef = 0;
  private joinRef: string | undefined;
  private unanswered: string | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: RelayRealtimeOptions) {
    this.WebSocket = options.WebSocket ?? globalThis.WebSocket;
  }

  /** The doorbell works: joined, and the line answers. */
  get subscribed(): boolean {
    return this.live;
  }

  start(delayMs = 0): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.retry(delayMs);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    const socket = this.socket;
    if (socket !== undefined) this.drop(socket);
  }

  private isStopped(): boolean {
    return this.stopped;
  }

  private retry(delayMs: number): void {
    clearTimeout(this.retryTimer);
    if (this.stopped) return;
    this.retryTimer = setTimeout(() => {
      void this.connect();
    }, delayMs);
    this.retryTimer.unref();
  }

  private backOff(): void {
    this.failures += 1;
    this.retry(
      Math.min(this.options.retryBaseMs * 2 ** (this.failures - 1), this.options.retryMaxMs),
    );
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.socket !== undefined) return;
    let session: RelaySessionResponse | undefined;
    try {
      session = await this.options.session();
    } catch (error) {
      if (error instanceof RelayError && error.code === 'REALTIME_NOT_CONFIGURED') {
        this.retry(this.options.notConfiguredRetryMs);
      } else {
        this.backOff();
      }
      return;
    }
    if (session === undefined) {
      this.retry(this.options.retryMaxMs);
      return;
    }
    // stop() may have come while the session was on its way.
    if (this.isStopped()) return;
    let socket: WebSocket;
    try {
      socket = new this.WebSocket(realtimeUrlOf(this.options.relayUrl, session.realtime.apiKey));
    } catch {
      this.backOff();
      return;
    }
    this.socket = socket;
    const current = session;
    socket.addEventListener('open', () => {
      this.join(socket, current);
      this.heartbeatTimer = setInterval(() => {
        this.heartbeat(socket);
      }, this.options.heartbeatMs);
      this.heartbeatTimer.unref();
    });
    socket.addEventListener('message', (event: MessageEvent) => {
      this.onMessage(socket, event.data, current);
    });
    // An error is always followed by close.
    socket.addEventListener('close', () => {
      this.lost(socket);
    });
  }

  private send(socket: WebSocket, event: string, payload: object, topic = TOPIC): string {
    this.nextRef += 1;
    const ref = String(this.nextRef);
    socket.send(JSON.stringify({ topic, event, payload, ref, join_ref: this.joinRef ?? ref }));
    return ref;
  }

  private join(socket: WebSocket, session: RelaySessionResponse): void {
    this.joinRef = undefined;
    this.joinRef = this.send(socket, 'phx_join', {
      config: {
        broadcast: { ack: false, self: false },
        presence: { key: '', enabled: false },
        postgres_changes: session.realtime.changes,
        private: false,
      },
      access_token: session.token,
    });
  }

  private heartbeat(socket: WebSocket): void {
    if (this.unanswered !== undefined) {
      // The last heartbeat got no answer: the line is dead even if the socket does not know yet.
      this.drop(socket);
      return;
    }
    this.unanswered = this.send(socket, 'heartbeat', {}, 'phoenix');
  }

  private onMessage(socket: WebSocket, data: unknown, session: RelaySessionResponse): void {
    if (socket !== this.socket || typeof data !== 'string') return;
    let message: PhoenixMessage;
    try {
      message = JSON.parse(data) as PhoenixMessage;
    } catch {
      return;
    }
    const payload = record(message.payload);
    if (message.event === 'phx_reply') {
      if (message.ref === this.unanswered) {
        this.unanswered = undefined;
      } else if (message.ref === this.joinRef) {
        this.joined(socket, session, payload);
      }
      return;
    }
    if (message.topic !== TOPIC) return;
    if (message.event === 'postgres_changes') {
      this.options.onRing();
    } else if (
      message.event === 'phx_error' ||
      message.event === 'phx_close' ||
      (message.event === 'system' && payload.status === 'error')
    ) {
      // The channel is gone (token run out, Realtime restarted): join again from scratch.
      this.drop(socket);
    }
  }

  /** The join's answer: subscribed only if Realtime took every change asked for. */
  private joined(
    socket: WebSocket,
    session: RelaySessionResponse,
    payload: Record<string, unknown>,
  ): void {
    const granted = record(payload.response).postgres_changes;
    const all =
      payload.status === 'ok' &&
      Array.isArray(granted) &&
      session.realtime.changes.every((change) =>
        granted.some((entry) => {
          const binding = record(entry);
          return (
            binding.event === change.event &&
            binding.schema === change.schema &&
            binding.table === change.table &&
            binding.filter === change.filter
          );
        }),
      );
    if (!all) {
      this.drop(socket);
      return;
    }
    this.failures = 0;
    this.setLive(true);
    // Whatever arrived before the join is picked up now.
    this.options.onRing();
    this.scheduleRefresh(socket, session.expiresAt);
  }

  private scheduleRefresh(socket: WebSocket, expiresAt: string): void {
    clearTimeout(this.refreshTimer);
    const delay = Math.max(
      1_000,
      Date.parse(expiresAt) - Date.now() - this.options.refreshBeforeMs,
    );
    this.refreshTimer = setTimeout(() => {
      void this.refresh(socket, expiresAt);
    }, delay);
    this.refreshTimer.unref();
  }

  /** A new token on the same channel; should that fail, Realtime closes it and we join again. */
  private async refresh(socket: WebSocket, expiresAt: string): Promise<void> {
    if (socket !== this.socket) return;
    let session: RelaySessionResponse | undefined;
    try {
      session = await this.options.session();
    } catch {
      session = undefined;
    }
    if (socket !== this.socket) return;
    if (session === undefined) {
      if (Date.parse(expiresAt) > Date.now() + this.options.retryBaseMs) {
        this.refreshTimer = setTimeout(() => {
          void this.refresh(socket, expiresAt);
        }, this.options.retryBaseMs);
        this.refreshTimer.unref();
      }
      return;
    }
    this.send(socket, 'access_token', { access_token: session.token });
    this.scheduleRefresh(socket, session.expiresAt);
  }

  /** Ends this line now; a new one follows unless stopped. */
  private drop(socket: WebSocket): void {
    try {
      socket.close();
    } catch {
      // Already closing.
    }
    this.lost(socket);
  }

  private lost(socket: WebSocket): void {
    if (socket !== this.socket) return;
    this.socket = undefined;
    this.joinRef = undefined;
    this.unanswered = undefined;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.refreshTimer);
    this.setLive(false);
    if (!this.stopped) this.backOff();
  }

  private setLive(live: boolean): void {
    if (this.live === live) return;
    this.live = live;
    this.options.onChange(live);
  }
}
