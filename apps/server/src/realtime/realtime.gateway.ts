import { Server as HttpServer } from 'node:http';
import { Server as HttpsServer } from 'node:https';
import type { Socket as NetSocket } from 'node:net';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  REALTIME_CONNECT_ERRORS,
  REALTIME_MESSAGES,
  REALTIME_NAMESPACE,
  REALTIME_PATH,
  type RealtimeEndReason,
  type RealtimeEnded,
  type RealtimeEvent,
  RealtimeHandshake,
  type RealtimeHead,
  RealtimeResyncRequest,
  type RealtimeSync,
} from '@rp/contracts';
import { businessDateOf, clientCompatibility, parseClientIdentity } from '@rp/domain';
import { type Namespace, Server, type Socket } from 'socket.io';
import { authErrors } from '../auth/auth-errors.js';
import type { AuthenticatedDevice } from '../auth/device.js';
import { DeviceTokenAuthenticator } from '../auth/device-token.authenticator.js';
import type { Principal } from '../auth/principal.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { ThrottledLog } from '../common/flood-limits.js';
import { SessionService } from '../auth/session.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { AppError } from '../errors/app-error.js';
import { EventBus, type PublishedEvent } from '../events/event-bus.js';
import { clientTooOld, SERVER_CLIENT_API } from '../http/client-version.js';
import { reaches, rooms, roomsForConnection, roomsForEvent } from './rooms.js';

export const REALTIME_OPTIONS = Symbol('REALTIME_OPTIONS');

export interface RealtimeOptions {
  /** How often live connections are re-checked against their device and session (AUTH-008). */
  readonly sweepIntervalMs: number;
  /** How often connections are told the head, so they can resume from it (NFR-P11). */
  readonly headIntervalMs: number;
  /** The largest gap replayed on reconnect; beyond it the client reloads (full refresh). */
  readonly maxReplay: number;
  readonly pingIntervalMs: number;
  readonly pingTimeoutMs: number;
  /** Resync requests allowed per connection per minute; more get a full-refresh answer. */
  readonly resyncsPerMinute: number;
  /** Live connections of one device at once (PC-D3); more are refused until some close. */
  readonly maxConnectionsPerDevice: number;
  /** Handshakes of one device per minute (PC-D3): each may replay events under the publish lock. */
  readonly handshakesPerMinutePerDevice: number;
  /**
   * Messages waiting for a connection that stopped reading (PC-D3): past this at two sweeps in a
   * row with nothing sent to it in between, or past ten times this, the sweep cuts it off; the
   * app reconnects and resyncs when it reads again.
   */
  readonly maxUnsentPerConnection: number;
}

export const DEFAULT_REALTIME_OPTIONS: RealtimeOptions = {
  // With the DeviceRevoked event as the fast path, the sweep is the ≤ 5 s guarantee (AUTH-008).
  sweepIntervalMs: 3_000,
  headIntervalMs: 15_000,
  maxReplay: 1_000,
  // Dead connections are noticed within ~20 s, well inside the 30 s reconnect target (NFR-P11).
  pingIntervalMs: 10_000,
  pingTimeoutMs: 10_000,
  resyncsPerMinute: 10,
  // An app has one; a browser tab each; a few more while dead ones wait for the ping timeout.
  maxConnectionsPerDevice: 16,
  // An app reconnects at most every second or so, even on Wi-Fi that drops and comes back.
  handshakesPerMinutePerDevice: 60,
  // A reconnecting app's replay goes out in one flush; a reading app empties this at once.
  maxUnsentPerConnection: 1_000,
};

/** Refusals of a device's connections are logged once a minute per device, with their count. */
const REFUSAL_LOG_PERIOD_MS = 60_000;

const REPLAY_BATCH = 500;
const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024;

/** Bytes the operating system has taken from a connection (`bytesWritten` counts queued ones). */
function bytesSent(tcp: NetSocket): number {
  return tcp.bytesWritten - tcp.writableLength;
}

interface ServerToClient {
  [REALTIME_MESSAGES.event]: (message: RealtimeEvent) => void;
  [REALTIME_MESSAGES.sync]: (message: RealtimeSync) => void;
  [REALTIME_MESSAGES.head]: (message: RealtimeHead) => void;
  [REALTIME_MESSAGES.ended]: (message: RealtimeEnded) => void;
}

interface ClientToServer {
  // Untrusted input: validated in the handler.
  [REALTIME_MESSAGES.resync]: (request: unknown, ack: unknown) => void;
}

interface ConnectionData {
  device: AuthenticatedDevice;
  principal: Principal | undefined;
  rooms: readonly string[];
  resume: { lastSequence?: number | undefined; streamId?: string | undefined };
  resyncs: number[];
  /** Messages made for the connection and not yet handed to its transport (PC-D3). */
  unsent: number;
  /** Bytes the operating system had taken from the connection at the last sweep. */
  sent: number;
  /** Sweeps in a row that found it over the limit with nothing sent since the one before. */
  stalls: number;
}

type RealtimeServer = Server<ClientToServer, ServerToClient, Record<string, never>, ConnectionData>;
type RealtimeNamespace = Namespace<
  ClientToServer,
  ServerToClient,
  Record<string, never>,
  ConnectionData
>;
type RealtimeSocket = Socket<ClientToServer, ServerToClient, Record<string, never>, ConnectionData>;

/** A refused handshake; the client's `connect_error` carries `message` = code and `data`. */
class ConnectRefusal extends Error {
  readonly data: { readonly code: string; readonly message: string };

  constructor(code: string, message: string) {
    super(code);
    this.name = 'ConnectRefusal';
    this.data = { code, message };
  }

  static from(error: AppError): ConnectRefusal {
    return new ConnectRefusal(error.code, error.message);
  }
}

/**
 * The real-time gateway (P0-12, BRD §10.4): Socket.io on the server's port, namespace `/rt`. It
 * admits paired devices (and the person signed in on them), puts each connection in the rooms it
 * may hear (`rooms.ts`), replays what a reconnecting device missed, and sends every published
 * event to its rooms in sequence order. Connections whose device is unpaired or whose session
 * ends are closed (AUTH-008). The protocol is documented in `@rp/contracts` (`realtime.ts`).
 */
@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  private io: RealtimeServer | undefined;
  private namespace: RealtimeNamespace | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly timers: NodeJS.Timeout[] = [];
  private sweeping: Promise<void> | undefined;
  /** Each device's live connections, and its handshakes in progress (PC-D3). */
  private readonly liveByDevice = new Map<string, number>();
  private readonly admittingByDevice = new Map<string, number>();
  private readonly handshakes = new RateLimiter();
  private readonly refusals = new ThrottledLog(
    REFUSAL_LOG_PERIOD_MS,
    (key, count) => {
      const [reason, deviceId] = key.split('|') as [string, string];
      this.logger.warn(
        { reason, deviceId, count },
        'Refused or closed a device’s live connections',
      );
    },
    () => performance.now(),
  );

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly bus: EventBus,
    private readonly devices: DeviceTokenAuthenticator,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    @Inject(REALTIME_OPTIONS) private readonly options: RealtimeOptions,
  ) {}

  onApplicationBootstrap(): void {
    // Undefined in an application context without HTTP (scripts); then there is nothing to serve.
    const adapter = this.adapterHost.httpAdapter as typeof this.adapterHost.httpAdapter | undefined;
    const server: unknown = adapter?.getHttpServer();
    if (!(server instanceof HttpServer) && !(server instanceof HttpsServer)) return;

    const io: RealtimeServer = new Server(server, {
      path: REALTIME_PATH,
      serveClient: false,
      transports: ['websocket'],
      pingInterval: this.options.pingIntervalMs,
      pingTimeout: this.options.pingTimeoutMs,
      maxHttpBufferSize: MAX_CLIENT_MESSAGE_BYTES,
      connectTimeout: 10_000,
    });
    // Nothing is served on the main namespace (deny by default).
    io.use((_socket, next) => {
      next(new ConnectRefusal('NOT_FOUND', `Connect to the ${REALTIME_NAMESPACE} namespace.`));
    });
    const namespace = io.of(REALTIME_NAMESPACE);
    namespace.use((socket, next) => {
      this.admit(socket).then(
        () => {
          next();
        },
        (error: unknown) => {
          next(this.refusal(error));
        },
      );
    });
    namespace.on('connection', (socket) => {
      void this.start(socket);
    });
    this.io = io;
    this.namespace = namespace;
    this.unsubscribe = this.bus.onPublished((events) => {
      this.broadcast(events);
    });
    this.every(this.options.sweepIntervalMs, () => {
      void this.sweep();
    });
    this.every(this.options.headIntervalMs, () => {
      void this.sendHeads();
    });
  }

  async onModuleDestroy(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.sweeping;
    const io = this.io;
    this.io = undefined;
    this.namespace = undefined;
    // Closes connections without the socket-level "disconnect", so clients reconnect by
    // themselves when the server is back (NFR-P11). Nest closes the HTTP server itself.
    io?.engine.close();
  }

  /** Devices of the restaurant with at least one live connection now (MGR-006). */
  connectedDeviceIds(restaurantId: string): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const socket of this.namespace?.sockets.values() ?? []) {
      const { device } = socket.data;
      if (device.restaurantId === restaurantId) ids.add(device.deviceId);
    }
    return ids;
  }

  /**
   * Re-checks every live connection: the device must still be paired with the same binding, and
   * a signed-in person's session must still be live with the same role (AUTH-005, AUTH-008).
   */
  sweep(): Promise<void> {
    this.sweeping ??= this.checkConnections().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  private every(intervalMs: number, tick: () => void): void {
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    this.timers.push(timer);
  }

  /** Handshake: who is connecting, and which rooms they may join. */
  private async admit(socket: RealtimeSocket): Promise<void> {
    if (!this.bus.ready) {
      throw new ConnectRefusal(
        REALTIME_CONNECT_ERRORS.starting,
        'The server is still starting. The app will retry.',
      );
    }
    const handshake = RealtimeHandshake.safeParse(socket.handshake.auth);
    if (!handshake.success) {
      throw new ConnectRefusal(
        REALTIME_CONNECT_ERRORS.handshakeInvalid,
        'Connect with the device token in the connection auth.',
      );
    }
    // N-1 (UPD-006): an app older than the server serves is told to update, as over REST.
    const client = parseClientIdentity(handshake.data.client);
    if (client !== undefined && clientCompatibility(SERVER_CLIENT_API, client.api) === 'TOO_OLD') {
      throw ConnectRefusal.from(clientTooOld(client));
    }
    let reserved: string | undefined;
    try {
      const device = await this.devices.authenticateToken(
        handshake.data.deviceToken,
        ({ deviceId }) => {
          // Before the database is asked: a device's handshakes and connections are limited.
          this.reserve(deviceId);
          reserved = deviceId;
        },
      );
      if (device === undefined) throw ConnectRefusal.from(authErrors.deviceNotRecognised());
      if (device.type === 'PAGER') {
        throw new ConnectRefusal(
          REALTIME_CONNECT_ERRORS.deviceNotAllowed,
          'Pagers receive their alerts over MQTT, not this connection.',
        );
      }
      // Always checked; without a token it simply fails and the device connects on its own
      // (CWE-807). A token that is sent must be valid.
      const accessToken = handshake.data.accessToken ?? '';
      // A (re)connection is the app's doing, not the person's: it keeps no idle session alive.
      const session = await this.sessions.authenticate(
        accessToken,
        device,
        Number.POSITIVE_INFINITY,
      );
      let principal: Principal | undefined;
      if ('principal' in session) principal = session.principal;
      else if (accessToken !== '') throw ConnectRefusal.from(session.failure);

      socket.data = {
        device,
        principal,
        rooms: roomsForConnection({
          device,
          ...(principal !== undefined && {
            person: { staffId: principal.staffId, role: principal.role },
            sectionIds: await this.sectionsOf(principal),
          }),
        }),
        resume: { lastSequence: handshake.data.lastSequence, streamId: handshake.data.streamId },
        resyncs: [],
        unsent: 0,
        sent: 0,
        stalls: 0,
      };
    } finally {
      if (reserved !== undefined) this.release(this.admittingByDevice, reserved);
    }
  }

  /**
   * Counts a handshake of the device, or refuses it (PC-D3): too many live connections now (the
   * ones in progress included), or too many handshakes in the last minute.
   */
  private reserve(deviceId: string): void {
    const now =
      (this.liveByDevice.get(deviceId) ?? 0) + (this.admittingByDevice.get(deviceId) ?? 0);
    if (
      now >= this.options.maxConnectionsPerDevice ||
      !this.handshakes.attempt(deviceId, this.options.handshakesPerMinutePerDevice, 60_000)
    ) {
      this.refusals.note(`too-many-connections|${deviceId}`);
      throw new ConnectRefusal(
        REALTIME_CONNECT_ERRORS.tooManyConnections,
        'This device has too many live connections. The app will retry.',
      );
    }
    this.admittingByDevice.set(deviceId, (this.admittingByDevice.get(deviceId) ?? 0) + 1);
  }

  private release(counts: Map<string, number>, deviceId: string): void {
    const left = (counts.get(deviceId) ?? 1) - 1;
    if (left <= 0) counts.delete(deviceId);
    else counts.set(deviceId, left);
  }

  private refusal(error: unknown): ConnectRefusal {
    if (error instanceof ConnectRefusal) return error;
    this.logger.error({ err: error }, 'Could not admit a live connection');
    return new ConnectRefusal(
      REALTIME_CONNECT_ERRORS.internalError,
      'The server could not accept the connection right now. The app will retry.',
    );
  }

  /** Sections the person is assigned to today (waiter sections, TBL / NTF routing). */
  private async sectionsOf(principal: Principal): Promise<string[]> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: principal.restaurantId },
      select: { timeZone: true, businessDayCutoff: true },
    });
    if (restaurant === null) return [];
    const businessDate = businessDateOf(new Date(), {
      timeZone: restaurant.timeZone,
      cutoff: restaurant.businessDayCutoff,
    });
    const assignments = await this.prisma.shiftAssignment.findMany({
      where: {
        restaurantId: principal.restaurantId,
        staffId: principal.staffId,
        businessDate: new Date(`${businessDate}T00:00:00.000Z`),
      },
      select: { sectionId: true },
    });
    return [...new Set(assignments.map((assignment) => assignment.sectionId))];
  }

  /**
   * A new connection: replay what it missed, then join its rooms, then `sync`, all while no batch
   * is being published, so it neither misses nor reorders an event.
   */
  private async start(socket: RealtimeSocket): Promise<void> {
    const { deviceId } = socket.data.device;
    this.liveByDevice.set(deviceId, (this.liveByDevice.get(deviceId) ?? 0) + 1);
    socket.once('disconnect', () => {
      this.release(this.liveByDevice, deviceId);
    });
    // Engine.io holds messages back while the transport is still writing earlier ones; a
    // connection that stops reading makes them pile up here (PC-D3).
    socket.conn.on('packetCreate', () => {
      socket.data.unsent += 1;
    });
    socket.conn.on('flush', (written: readonly unknown[]) => {
      socket.data.unsent -= written.length;
    });
    socket.on(REALTIME_MESSAGES.resync, (request: unknown, ack: unknown) => {
      void this.resync(socket, request, ack);
    });
    try {
      await this.bus.withPublishLock(async () => {
        const sync = await this.replay(socket, socket.data.resume);
        if (!socket.connected) return;
        await socket.join([...socket.data.rooms]);
        socket.emit(REALTIME_MESSAGES.sync, sync);
      });
    } catch (error) {
      this.logger.error({ err: error }, 'Could not start a live connection');
      // Transport-level close: the client reconnects and tries again.
      socket.conn.close();
    }
  }

  private async resync(socket: RealtimeSocket, request: unknown, ack: unknown): Promise<void> {
    if (typeof ack !== 'function') return;
    const respond = ack as (sync: RealtimeSync) => void;
    const parsed = RealtimeResyncRequest.safeParse(request);
    const now = Date.now();
    const recent = socket.data.resyncs.filter((at) => now - at < 60_000);
    socket.data.resyncs = recent;
    if (!parsed.success || recent.length >= this.options.resyncsPerMinute) {
      respond({ streamId: this.bus.streamId, head: this.bus.head, replayed: 0, fullRefresh: true });
      return;
    }
    recent.push(now);
    try {
      respond(await this.bus.withPublishLock(() => this.replay(socket, parsed.data)));
    } catch (error) {
      this.logger.error({ err: error }, 'Could not replay events');
      respond({ streamId: this.bus.streamId, head: this.bus.head, replayed: 0, fullRefresh: true });
    }
  }

  /**
   * Sends a connection the events after `lastSequence` it may see (NTF-006, NFR-P11), or asks it
   * to reload when that cannot be done exactly. Runs under the publish lock.
   */
  private async replay(
    socket: RealtimeSocket,
    resume: { readonly lastSequence?: number | undefined; readonly streamId?: string | undefined },
  ): Promise<RealtimeSync> {
    const head = this.bus.head;
    const streamId = this.bus.streamId;
    const reload: RealtimeSync = { streamId, head, replayed: 0, fullRefresh: true };
    const { lastSequence } = resume;
    if (lastSequence === undefined || resume.streamId !== streamId || lastSequence > head) {
      return reload;
    }
    if (lastSequence === head) return { ...reload, fullRefresh: false };
    if (head - lastSequence > this.options.maxReplay) return reload;
    const oldest = await this.bus.oldestRetained();
    if (oldest === undefined || oldest > lastSequence + 1) return reload;

    const joined = new Set(socket.data.rooms);
    let after = lastSequence;
    let replayed = 0;
    for (;;) {
      const events = await this.bus.readPublished({
        restaurantId: socket.data.device.restaurantId,
        after,
        upTo: head,
        limit: REPLAY_BATCH,
      });
      for (const { sequence, event, audience } of events) {
        if (!reaches(roomsForEvent(event, audience), joined)) continue;
        socket.emit(REALTIME_MESSAGES.event, { sequence, event });
        replayed += 1;
      }
      const last = events.at(-1);
      if (last === undefined || events.length < REPLAY_BATCH) break;
      after = last.sequence;
    }
    return { streamId, head, replayed, fullRefresh: false };
  }

  /**
   * Whether the person has a live connection now (NTF-007): signed in somewhere, e.g. the waiter
   * app, or the waiter phone that alerts them is connected, signed in or not (P2-06a).
   */
  isStaffConnected(restaurantId: string, staffId: string): boolean {
    const joined = this.namespace?.adapter.rooms;
    return [rooms.staff(restaurantId, staffId), rooms.alerts(restaurantId, staffId)].some(
      (name) => (joined?.get(name)?.size ?? 0) > 0,
    );
  }

  /** Live listener: each published event goes to its rooms (ORD-010). */
  private broadcast(events: readonly PublishedEvent[]): void {
    const namespace = this.namespace;
    if (namespace === undefined) return;
    for (const { sequence, event, audience } of events) {
      const targets = roomsForEvent(event, audience);
      if (targets.length > 0) {
        namespace.to(targets).emit(REALTIME_MESSAGES.event, { sequence, event });
      }
      if (event.type === 'DeviceRevoked') {
        // AUTH-008: an unpaired device's connections close at once.
        this.endRoom(rooms.device(event.restaurantId, event.payload.deviceId), 'DEVICE_REVOKED');
      }
    }
  }

  private async sendHeads(): Promise<void> {
    const namespace = this.namespace;
    if (namespace === undefined) return;
    try {
      await this.bus.withPublishLock(() => {
        const restaurants = new Set<string>();
        for (const socket of namespace.sockets.values()) {
          restaurants.add(socket.data.device.restaurantId);
        }
        const head: RealtimeHead = { streamId: this.bus.streamId, head: this.bus.head };
        // Connections join `all` when their replay is done, so a head never overtakes a replay.
        for (const restaurantId of restaurants) {
          namespace.to(rooms.all(restaurantId)).emit(REALTIME_MESSAGES.head, head);
        }
      });
    } catch (error) {
      this.logger.warn({ err: error }, 'Could not send the head to live connections');
    }
  }

  private async checkConnections(): Promise<void> {
    const namespace = this.namespace;
    if (namespace === undefined) return;
    const sockets = [...namespace.sockets.values()].filter((socket) => this.reading(socket));
    if (sockets.length === 0) return;
    try {
      // Sessions first, devices second: unpairing revokes the device and its sessions in one
      // transaction, so a device row read after the sessions is never older than them, and an
      // unpaired device is reported as such rather than as a signed-out person.
      const live = await this.sessions.liveSessions(
        sockets.flatMap(({ data }) =>
          data.principal === undefined
            ? []
            : [{ sessionId: data.principal.sessionId, device: data.device }],
        ),
      );
      const devices = await this.prisma.device.findMany({
        where: { id: { in: [...new Set(sockets.map((socket) => socket.data.device.deviceId))] } },
        select: { id: true, status: true, tableId: true, stationId: true, staffId: true },
      });
      const deviceById = new Map(devices.map((device) => [device.id, device]));
      const recheck: { socket: RealtimeSocket; principal: Principal }[] = [];
      for (const socket of sockets) {
        const { device, principal } = socket.data;
        const row = deviceById.get(device.deviceId);
        if (row?.status !== 'ACTIVE') {
          this.end(socket, 'DEVICE_REVOKED');
        } else if (principal !== undefined && live.get(principal.sessionId) !== principal.role) {
          // Before a binding change: signing out on a waiter phone also ends its alerts (P2-06a),
          // and the app must hear that the person is signed out.
          this.end(socket, 'SESSION_ENDED');
        } else if (
          row.tableId !== device.tableId ||
          row.stationId !== device.stationId ||
          row.staffId !== device.staffId
        ) {
          if (principal === undefined) this.end(socket, 'DEVICE_CHANGED');
          else recheck.push({ socket, principal });
        }
      }
      if (recheck.length > 0) {
        // A sign-out on a waiter phone ends the session and clears the phone's holder in one
        // transaction (P2-06a). Committed between the two reads above, it shows as a binding
        // change with a live session: read those sessions again, after the devices, so the app
        // still hears that the person signed out.
        const again = await this.sessions.liveSessions(
          recheck.map(({ socket, principal }) => ({
            sessionId: principal.sessionId,
            device: socket.data.device,
          })),
        );
        for (const { socket, principal } of recheck) {
          this.end(
            socket,
            again.get(principal.sessionId) === principal.role ? 'DEVICE_CHANGED' : 'SESSION_ENDED',
          );
        }
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'Could not re-check live connections; will retry');
    }
  }

  /**
   * Whether the connection still reads what it is sent; one that stopped while messages piled up
   * is cut off (PC-D3): many waiting and nothing sent to it for two sweeps, or far too many. A
   * paired device that stops reading but answers pings would otherwise keep the server buffering
   * for it all day. Its TCP connection is destroyed: closing it politely would wait for those
   * messages to go out first, which they never do.
   */
  private reading(socket: RealtimeSocket): boolean {
    const { unsent } = socket.data;
    const sent = bytesSent(socket.request.socket);
    const moved = sent !== socket.data.sent;
    socket.data.sent = sent;
    const limit = this.options.maxUnsentPerConnection;
    // A reading app may have many waiting just after a burst of events, while engine.io holds
    // them back until the previous flush is all written (megabytes after a replay, read at the
    // app's pace), so progress is what the operating system took, not whole flushes. Two sweeps,
    // as one can come straight after this PC was too busy to write to anyone.
    socket.data.stalls = unsent > limit && !moved ? socket.data.stalls + 1 : 0;
    if (unsent <= limit * 10 && socket.data.stalls < 2) return true;
    this.refusals.note(`stopped-reading|${socket.data.device.deviceId}`);
    socket.request.socket.destroy();
    return false;
  }

  /** A device's binding changed (its stations, say): its connections reconnect to new rooms. */
  reconnectDevice(restaurantId: string, deviceId: string): void {
    this.endRoom(rooms.device(restaurantId, deviceId), 'DEVICE_CHANGED');
  }

  private end(socket: RealtimeSocket, reason: RealtimeEndReason): void {
    if (!socket.connected) return;
    socket.emit(REALTIME_MESSAGES.ended, { reason });
    socket.disconnect(true);
  }

  private endRoom(room: string, reason: RealtimeEndReason): void {
    const namespace = this.namespace;
    if (namespace === undefined) return;
    namespace.to(room).emit(REALTIME_MESSAGES.ended, { reason });
    namespace.in(room).disconnectSockets(true);
  }
}
