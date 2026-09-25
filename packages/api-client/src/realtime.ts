import {
  type DomainEvent,
  REALTIME_CONNECT_ERRORS,
  REALTIME_MESSAGES,
  REALTIME_NAMESPACE,
  REALTIME_PATH,
  RealtimeEnded,
  type RealtimeEndReason,
  RealtimeEvent,
  RealtimeHead,
  RealtimeSync,
} from '@rp/contracts';
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';

export type RecoveryDecision = 'retry' | 'stop';

/** Where the connection's credentials come from (the `ApiClient`). */
export interface RealtimeAuthority {
  /** Fresh credentials for a (re)connection. */
  handshake(): Promise<{ deviceToken: string; accessToken?: string }>;
  /** The server refused the handshake with `code`: fix what can be fixed, then retry or stop. */
  recover(code: string): Promise<RecoveryDecision>;
  /** The server ended the connection (AUTH-008): forget what it says is over. */
  ended(reason: RealtimeEndReason): void;
}

/** Where to resume: the highest sequence seen and the stream it belongs to (NFR-P11). */
export interface ResumePoint {
  readonly lastSequence: number;
  readonly streamId: string;
}

/**
 * - `connecting`: first connection, not yet in sync;
 * - `online`: connected and caught up;
 * - `offline`: lost; reconnecting by itself (show the connection banner);
 * - `stopped`: closed for good (stopped, or the device was unpaired).
 */
export type ConnectionStatus = 'connecting' | 'online' | 'offline' | 'stopped';

export interface RealtimeHandlers {
  /** Each event once, in order (duplicates from replays are dropped, NTF-006). */
  readonly onEvent: (event: DomainEvent, sequence: number) => void;
  /** After every (re)connection. `fullRefresh`: reload the screen's state over REST. */
  readonly onSync?: (sync: RealtimeSync) => void;
  readonly onStatus?: (status: ConnectionStatus) => void;
  /** The server ended the connection: the session ended, the device changed or was unpaired. */
  readonly onEnded?: (reason: RealtimeEndReason) => void;
  /** Persist it to resume after an app restart instead of reloading everything. */
  readonly onResumePoint?: (point: ResumePoint) => void;
}

export interface RealtimeConnectionOptions extends RealtimeHandlers {
  /** The server's base URL; empty for the page's own origin. */
  readonly url: string;
  readonly resume?: ResumePoint;
  /** First retry delay after a refused handshake; doubles up to `retryMaxMs`. */
  readonly retryMs?: number;
  readonly retryMaxMs?: number;
  /** Socket.io's `io`; tests pass a fake. */
  readonly connect?: (
    url: string,
    options: Partial<ManagerOptions & SocketOptions>,
  ) => Pick<Socket, 'on' | 'connect' | 'disconnect' | 'active' | 'timeout'>;
}

const SEEN_LIMIT = 2_000;
/** Refusals worth retrying as they are: the server is starting or had a hiccup. */
const TRANSIENT = new Set<string>([
  REALTIME_CONNECT_ERRORS.starting,
  REALTIME_CONNECT_ERRORS.internalError,
]);

/**
 * The live connection to the local server (P0-12 protocol, `@rp/contracts` realtime.ts). It keeps
 * the resume point, de-duplicates by event id, reconnects by itself (≤ 5 s between attempts, well
 * inside NFR-P11's 30 s), renews credentials when the server refuses them, and reports status for
 * the connection banner.
 */
export class RealtimeConnection {
  private socket: ReturnType<NonNullable<RealtimeConnectionOptions['connect']>> | undefined;
  private point: ResumePoint | undefined;
  private readonly seen = new Set<string>();
  private currentStatus: ConnectionStatus = 'stopped';
  private endedReason: RealtimeEndReason | undefined;
  private refusals = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private handshakeFailed = false;

  constructor(
    private readonly authority: RealtimeAuthority,
    private readonly options: RealtimeConnectionOptions,
  ) {
    this.point = options.resume;
  }

  get status(): ConnectionStatus {
    return this.currentStatus;
  }

  get resumePoint(): ResumePoint | undefined {
    return this.point;
  }

  start(): void {
    if (this.socket !== undefined) return;
    const connect = this.options.connect ?? io;
    const socket = connect(`${this.options.url}${REALTIME_NAMESPACE}`, {
      path: REALTIME_PATH,
      transports: ['websocket'],
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
      randomizationFactor: 0.5,
      auth: (reply: (auth: Record<string, unknown>) => void) => {
        this.authority.handshake().then(
          (credentials) => {
            this.handshakeFailed = false;
            reply({
              ...credentials,
              ...(this.point !== undefined && {
                lastSequence: this.point.lastSequence,
                streamId: this.point.streamId,
              }),
            });
          },
          () => {
            // Offline or renewing failed: the refused handshake is retried later.
            this.handshakeFailed = true;
            reply({});
          },
        );
      },
    });
    this.socket = socket;
    socket.on(REALTIME_MESSAGES.event, (message: unknown) => {
      this.onEventMessage(message);
    });
    socket.on(REALTIME_MESSAGES.sync, (message: unknown) => {
      const sync = RealtimeSync.safeParse(message);
      if (sync.success) this.onSyncMessage(sync.data);
    });
    socket.on(REALTIME_MESSAGES.head, (message: unknown) => {
      const head = RealtimeHead.safeParse(message);
      if (head.success && head.data.streamId === this.point?.streamId) {
        this.advance(head.data.head, head.data.streamId);
      }
    });
    socket.on(REALTIME_MESSAGES.ended, (message: unknown) => {
      const ended = RealtimeEnded.safeParse(message);
      if (ended.success) this.endedReason = ended.data.reason;
    });
    socket.on('disconnect', (reason: string) => {
      this.onDisconnect(reason);
    });
    socket.on('connect_error', (error: Error & { data?: unknown }) => {
      void this.onConnectError(error);
    });
    this.setStatus('connecting');
    socket.connect();
  }

  /** Closes the connection for good. */
  stop(): void {
    clearTimeout(this.retryTimer);
    const socket = this.socket;
    this.socket = undefined;
    socket?.disconnect();
    this.setStatus('stopped');
  }

  /** Asks the server for what was missed since the resume point (e.g. after the app resumes). */
  async resync(): Promise<RealtimeSync | undefined> {
    const socket = this.socket;
    if (socket === undefined || this.point === undefined) return undefined;
    const answer: unknown = await socket.timeout(10_000).emitWithAck(REALTIME_MESSAGES.resync, {
      lastSequence: this.point.lastSequence,
      streamId: this.point.streamId,
    });
    const sync = RealtimeSync.safeParse(answer);
    if (!sync.success) return undefined;
    this.onSyncMessage(sync.data);
    return sync.data;
  }

  private onEventMessage(message: unknown): void {
    const parsed = RealtimeEvent.safeParse(message);
    if (!parsed.success) return;
    const { sequence, event } = parsed.data;
    if (this.point !== undefined) this.advance(sequence, this.point.streamId);
    if (this.seen.has(event.eventId)) return;
    this.seen.add(event.eventId);
    if (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.options.onEvent(event, sequence);
  }

  private onSyncMessage(sync: RealtimeSync): void {
    this.refusals = 0;
    if (sync.fullRefresh || this.point?.streamId !== sync.streamId) {
      this.point = { lastSequence: sync.head, streamId: sync.streamId };
      this.options.onResumePoint?.(this.point);
    } else {
      this.advance(sync.head, sync.streamId);
    }
    this.setStatus('online');
    this.options.onSync?.(sync);
  }

  private advance(sequence: number, streamId: string): void {
    if (this.point !== undefined && sequence <= this.point.lastSequence) return;
    this.point = { lastSequence: sequence, streamId };
    this.options.onResumePoint?.(this.point);
  }

  private onDisconnect(reason: string): void {
    const socket = this.socket;
    if (socket === undefined) return;
    if (reason !== 'io server disconnect') {
      // Transport lost (server restart, Wi-Fi): Socket.io reconnects by itself.
      this.setStatus('offline');
      return;
    }
    const ended = this.endedReason;
    this.endedReason = undefined;
    if (ended !== undefined) {
      this.authority.ended(ended);
      this.options.onEnded?.(ended);
    }
    if (ended === 'DEVICE_REVOKED') {
      this.stop();
      return;
    }
    if (ended === 'DEVICE_CHANGED') {
      // New rooms: what was seen before no longer describes this device's view.
      this.point = undefined;
    }
    this.setStatus('offline');
    socket.connect();
  }

  private async onConnectError(error: Error & { data?: unknown }): Promise<void> {
    const socket = this.socket;
    if (socket === undefined) return;
    this.setStatus(this.currentStatus === 'connecting' ? 'connecting' : 'offline');
    // Unreachable server: Socket.io keeps trying by itself.
    if (socket.active) return;
    const data = error.data as { code?: unknown } | undefined;
    const code = typeof data?.code === 'string' ? data.code : error.message;
    let decision: RecoveryDecision = 'retry';
    if (!this.handshakeFailed && !TRANSIENT.has(code)) {
      decision = await this.authority.recover(code);
    }
    if (this.socket !== socket) return;
    if (decision === 'stop') {
      this.stop();
      return;
    }
    this.refusals += 1;
    const base = this.options.retryMs ?? 500;
    const delay = Math.min(this.options.retryMaxMs ?? 10_000, base * 2 ** (this.refusals - 1));
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.socket === socket) socket.connect();
    }, delay);
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    this.options.onStatus?.(status);
  }
}
