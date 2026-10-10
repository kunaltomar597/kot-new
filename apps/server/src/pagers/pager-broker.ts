import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  type AlertListResponse,
  type NotificationEventType,
  PagerAckMessage,
  type PagerAlertMessage,
  type PagerFirmwareOffer,
  PagerHeartbeat,
} from '@rp/contracts';
import {
  isLowBattery,
  type NotificationEvent,
  pagerHeartbeatTooSoon,
  pagerIsOffline,
  pagerLines,
  pagerMayPublish,
  pagerMaySubscribe,
  pagerTopic,
  reachesPagerAndApp,
  vibrationFor,
} from '@rp/domain';
import { Aedes, type AuthenticateError, type Client } from 'aedes';
import { CredentialHasher } from '../auth/credential-hasher.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { currentBusinessDate } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { EventBus, type PublishedEvent } from '../events/event-bus.js';
import { appendEvent } from '../events/outbox.js';
import { NOTIFICATION_CLOCK, type NotificationClock } from '../notifications/clock.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PresenceRegistry } from '../notifications/presence.js';
import { TlsService } from '../tls/tls.service.js';
import {
  BUSY,
  ConnectionGate,
  type GateLimits,
  type GateTicket,
  LimitedConnection,
  TaskLimiter,
  ThrottledLog,
  TokenBucket,
} from './broker-limits.js';

export const PAGER_OPTIONS = Symbol('PAGER_OPTIONS');

/**
 * The broker's limits (PAGER-D3, PAGER-D4). Not BRD ⚙ values: they protect the POS server, and a
 * restaurant has at most a few dozen pagers (design capacity 30).
 */
export interface PagerBrokerLimits extends GateLimits {
  /** The TLS handshake and the CONNECT packet must come within this time. */
  readonly signInMs: number;
  /** The largest packet before sign-in: a pager's CONNECT is under 200 bytes. */
  readonly maxConnectBytes: number;
  /** The largest packet after sign-in: a heartbeat with a firmware report is under 400. */
  readonly maxPacketBytes: number;
  /** Argon2id checks of pager secrets at once, and how many may wait for one. */
  readonly maxChecksAtOnce: number;
  readonly maxChecksWaiting: number;
}

export const DEFAULT_PAGER_LIMITS: PagerBrokerLimits = {
  maxConnections: 256,
  maxPending: 64,
  maxPendingPerAddress: 4,
  trustLoopback: true,
  signInMs: 10_000,
  maxConnectBytes: 1_024,
  maxPacketBytes: 4_096,
  maxChecksAtOnce: 2,
  maxChecksWaiting: 64,
};

export interface PagerOptions extends Partial<PagerBrokerLimits> {
  /** How often pagers are checked for missed heartbeats (0: never; tests call it). */
  readonly offlineCheckMs: number;
  /** A monotonic clock in milliseconds for the heartbeat rate (tests move it on). */
  readonly clockMs?: () => number;
}

export const DEFAULT_PAGER_OPTIONS: PagerOptions = { offlineCheckMs: 10_000 };

export interface ConnectedPager {
  readonly restaurantId: string;
  readonly deviceId: string;
  staffId: string | null;
}

/**
 * A signed-in pager's session: whom it is for, where from, its last heartbeat taken and what is
 * left of its acknowledgements.
 */
interface PagerSession extends ConnectedPager {
  readonly address: string;
  lastBeatAtMs: number | null;
  readonly acks: TokenBucket;
}

/** A pager's acknowledgements: ten at once, then one a second (PAGER-D4). */
const ACK_BURST = 10;
const ACK_EVERY_MS = 1_000;

/** Called after each heartbeat is stored (the firmware service listens, P2-04b). */
export type PagerHeartbeatListener = (
  pager: Readonly<ConnectedPager>,
  beat: PagerHeartbeat,
) => Promise<void>;

const SERVER_UNAVAILABLE = 3;
const NOT_AUTHORIZED = 5;
const LOG_PERIOD_MS = 60_000;
const DEVICE_ID = /^[0-9a-f-]{36}$/;

function refused(): AuthenticateError {
  return Object.assign(new Error('Bad pager credential'), { returnCode: NOT_AUTHORIZED });
}

/** Too many sign-ins at once: the pager tries again a moment later. */
function busy(): AuthenticateError {
  return Object.assign(new Error('Busy, try again'), { returnCode: SERVER_UNAVAILABLE });
}

/** Why a connection was refused or ended, as the log says it. */
const REFUSALS = {
  'not-a-pager': 'Pager sign-in refused: no active pager by that name',
  'wrong-secret': 'Pager sign-in refused: wrong secret',
  'checks-busy': 'Pager sign-in refused: too many sign-ins at once',
  'too-many-connections': 'Pager connection refused: too many connections',
  'too-large': 'Pager connection ended: a packet over the limit',
  'will-message': 'Pager sign-in refused: a will message',
  'not-allowed': 'Pager message refused: not its topic, retained or QoS 2',
  'fast-heartbeats': 'Pager heartbeats dropped: faster than half the interval',
  'fast-acks': 'Pager acknowledgements dropped: more than the button can press',
} as const;
type Refusal = keyof typeof REFUSALS;

function addressOf(client: Client): string {
  return (client.conn as Partial<LimitedConnection>).remoteAddress ?? 'unknown';
}

/**
 * The pagers' MQTT broker (P2-04, PGR-005, PGR-007, PGR-008, SEC-012), embedded in the server:
 * - MQTTS with the installation's certificate when TLS is on (ADR-0011);
 * - each pager signs in with its own credential (client id = user name = its device id);
 * - it may subscribe only to its own alerts topic and publish only its own ack and heartbeat;
 * - alerts reach the wearer's pager at QoS 1, and a reconnecting pager is sent every open alert of
 *   its wearer again (it de-duplicates by alert id and repeat number);
 * - heartbeats keep battery, signal, firmware and charging; three missed heartbeats mark it
 *   offline;
 * - it may also subscribe to its own `ota` topic, where firmware offers come (PGR-011, P2-04b);
 * - it limits what anyone on the LAN can make it do (P8-03b2b): connections in all and per address
 *   before sign-in, the time to sign in, packet sizes before and after it, Argon2id checks at
 *   once, heartbeats faster than half the interval, bursts of acknowledgements, retained, QoS 2
 *   and will messages; refusals are logged once a minute per address with their count, and wrong
 *   secrets counted per pager.
 */
@Injectable()
export class PagerBroker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PagerBroker.name);
  private broker: Aedes | undefined;
  private server: NetServer | TlsServer | undefined;
  /** Each signed-in client's session, from its sign-in on (PAGER-D6). */
  private readonly sessions = new WeakMap<Client, PagerSession>();
  /** Clients whose CONNECT carried a will message. */
  private readonly withWill = new WeakSet<Client>();
  /** The pagers the broker has, by device: only once the broker has their client. */
  private readonly connected = new Map<string, { client: Client; pager: PagerSession }>();
  private readonly limits: PagerBrokerLimits;
  private readonly checks: TaskLimiter;
  private readonly refusals: ThrottledLog;
  private readonly clockMs: () => number;
  private unsubscribe: (() => void) | undefined;
  private stopRenewals: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopPresence: (() => void) | undefined;
  private readonly heartbeatListeners: PagerHeartbeatListener[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PAGER_OPTIONS) private readonly options: PagerOptions,
    @Inject(NOTIFICATION_CLOCK) private readonly clock: NotificationClock,
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly notifications: NotificationsService,
    private readonly tls: TlsService,
    private readonly presence: PresenceRegistry,
    private readonly hasher: CredentialHasher,
  ) {
    this.limits = { ...DEFAULT_PAGER_LIMITS, ...options };
    this.checks = new TaskLimiter(this.limits.maxChecksAtOnce, this.limits.maxChecksWaiting);
    this.clockMs = options.clockMs ?? (() => performance.now());
    this.refusals = new ThrottledLog(
      LOG_PERIOD_MS,
      (key, count) => {
        const [reason, address, deviceId] = key.split('|') as [Refusal, string, string];
        this.logger.warn(
          { reason, address, ...(deviceId !== '' && { deviceId }), count },
          REFUSALS[reason],
        );
      },
      this.clockMs,
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.mqtt === 'off') return;
    const broker = await Aedes.createBroker({
      connectTimeout: this.limits.signInMs,
      // Pagers publish at QoS 1; QoS 2 is refused, so nothing waits for its release.
      maxInflightInbound: 1,
      preConnect: (client, packet, done) => {
        // A pager has no use for a will message, which the broker would keep for it: refused at
        // the sign-in, so the pager hears why.
        if (packet.will !== undefined) this.withWill.add(client);
        done(null, true);
      },
      authenticate: (client, username, password, done) => {
        this.authenticate(client, username, password).then(
          (outcome) => {
            if (outcome === 'BUSY') done(busy(), false);
            else done(outcome === 'OK' ? null : refused(), outcome === 'OK');
          },
          (error: unknown) => {
            this.logger.error(`Pager sign-in failed: ${String(error)}`);
            done(refused(), false);
          },
        );
      },
      authorizeSubscribe: (client, subscription, done) => {
        const pager = this.sessions.get(client);
        if (
          pager === undefined ||
          !pagerMaySubscribe(subscription.topic, pager.restaurantId, pager.deviceId)
        ) {
          // A null subscription is refused with 0x80 in the SUBACK, keeping the connection.
          done(null, null);
          return;
        }
        done(null, { ...subscription, qos: 1 });
      },
      authorizePublish: (client, packet, done) => {
        // The server's own publishes have no client.
        if (client === null) {
          done(null);
          return;
        }
        const pager = this.sessions.get(client);
        // Only its own ack and heartbeat, never kept by the broker (retained), at QoS 0 or 1.
        if (
          pager === undefined ||
          packet.retain ||
          packet.qos === 2 ||
          !pagerMayPublish(packet.topic, pager.restaurantId, pager.deviceId)
        ) {
          this.refusal('not-allowed', addressOf(client), pager?.deviceId);
          done(new Error('Not allowed'));
          return;
        }
        done(null);
      },
    });
    broker.on('publish', (packet, client) => {
      if (client === null) return;
      const pager = this.sessions.get(client);
      if (pager === undefined) return;
      void this.received(pager, packet.topic, packet.payload).catch((error: unknown) => {
        this.logger.error(`Pager message failed: ${String(error)}`);
      });
    });
    broker.on('clientReady', (client) => {
      const pager = this.sessions.get(client);
      if (pager === undefined) return;
      // PAGER-D6: it counts as connected only now, when the broker has it.
      this.connected.set(client.id, { client, pager });
      void this.resend(client.id).catch((error: unknown) => {
        this.logger.error(`Could not resend alerts to a pager: ${String(error)}`);
      });
    });
    broker.on('clientDisconnect', (client) => {
      // A session closing removes only its own entry, not a newer one of the same pager.
      if (this.connected.get(client.id)?.client === client) this.connected.delete(client.id);
    });
    this.broker = broker;
    this.stopPresence = this.presence.add((restaurantId, staffId) =>
      this.isStaffConnected(restaurantId, staffId),
    );
    const tlsOptions = await this.tls.listenerOptions();
    const gate = new ConnectionGate(this.limits);
    const tickets = new Map<string, GateTicket>();
    const keyOf = (socket: Socket) =>
      `${socket.remoteAddress ?? ''}|${String(socket.remotePort ?? '')}`;
    // The MQTT stream, after the TLS handshake when TLS is on.
    const handle = (socket: Socket) => {
      if (socket.destroyed) return;
      const address = socket.remoteAddress ?? 'unknown';
      const connection = new LimitedConnection(
        socket,
        this.limits.maxConnectBytes,
        tickets.get(keyOf(socket)),
        () => {
          this.refusal('too-large', address);
        },
      );
      broker.handle(connection);
    };
    let server: NetServer | TlsServer;
    if (tlsOptions === undefined) {
      server = createNetServer();
      server.on('connection', handle);
    } else {
      const secure = createTlsServer({ ...tlsOptions, handshakeTimeout: this.limits.signInMs });
      secure.on('secureConnection', handle);
      // A handshake that fails or takes longer than the sign-in time only reports it: end it.
      secure.on('tlsClientError', (_error, socket) => {
        socket.destroy();
      });
      this.stopRenewals = this.tls.onRenewed((options) => {
        secure.setSecureContext(options);
      });
      server = secure;
    }
    // Every TCP connection is admitted first, before its TLS handshake (PAGER-D3).
    server.prependListener('connection', (socket: Socket) => {
      const ticket = gate.admit(socket.remoteAddress);
      if (ticket === undefined) {
        this.refusal('too-many-connections', socket.remoteAddress ?? 'unknown');
        socket.destroy();
        return;
      }
      const key = keyOf(socket);
      tickets.set(key, ticket);
      socket.once('close', () => {
        ticket.closed();
        if (tickets.get(key) === ticket) tickets.delete(key);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.mqttPort, this.config.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.unsubscribe = this.bus.onPublished((events) => {
      for (const published of events) {
        const { event } = published;
        // AUTH-008: an unpaired pager loses its connection at once, not at its next sign-in.
        if (event.type === 'DeviceRevoked') {
          if (event.payload.deviceType === 'PAGER') this.disconnect(event.payload.deviceId);
          continue;
        }
        void this.deliver(published).catch((error: unknown) => {
          this.logger.error(`Pager delivery failed: ${String(error)}`);
        });
      }
    });
    if (this.options.offlineCheckMs > 0) {
      this.timer = setInterval(() => {
        void this.checkOffline().catch((error: unknown) => {
          this.logger.error(`Pager offline check failed: ${String(error)}`);
        });
      }, this.options.offlineCheckMs);
      this.timer.unref();
    }
    this.logger.log(
      `Pager broker listening on ${String(this.port())} (${tlsOptions ? 'MQTTS' : 'MQTT'})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    this.unsubscribe?.();
    this.stopRenewals?.();
    this.stopPresence?.();
    const broker = this.broker;
    this.broker = undefined;
    if (broker !== undefined)
      await new Promise<void>((resolve) => {
        broker.close(() => {
          resolve();
        });
      });
    const server = this.server;
    this.server = undefined;
    if (server !== undefined)
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
  }

  /** The port the broker listens on (a free one when configured as 0). */
  port(): number | null {
    const address = this.server?.address();
    return address !== undefined && address !== null && typeof address !== 'string'
      ? address.port
      : null;
  }

  /** NTF-007: whether the person's pager is connected now. */
  isStaffConnected(restaurantId: string, staffId: string): boolean {
    for (const { pager } of this.connected.values()) {
      if (pager.restaurantId === restaurantId && pager.staffId === staffId) return true;
    }
    return false;
  }

  /** The pagers connected now. */
  connectedPagers(): readonly Readonly<ConnectedPager>[] {
    return [...this.connected.values()].map(({ pager }) => pager);
  }

  /** Hears every pager heartbeat once it is stored. */
  onHeartbeat(listener: PagerHeartbeatListener): void {
    this.heartbeatListeners.push(listener);
  }

  /**
   * Sends a firmware offer to a connected pager on its own `ota` topic, QoS 1 (PGR-011). False
   * when the pager is not connected.
   */
  async offerFirmware(deviceId: string, offer: PagerFirmwareOffer): Promise<boolean> {
    const pager = this.connected.get(deviceId)?.pager;
    if (pager === undefined || this.broker === undefined) return false;
    await this.publishTo(pager, 'ota', offer);
    return true;
  }

  /** A pager changed hands (PGR-012): route to the new wearer and send them the open alerts. */
  async reassigned(deviceId: string, staffId: string | null): Promise<void> {
    const pager = this.connected.get(deviceId)?.pager;
    if (pager === undefined) return;
    pager.staffId = staffId;
    await this.resend(deviceId);
  }

  /**
   * Drops a pager's connection: its credential was replaced, it was revoked, or it stopped sending
   * heartbeats. What it sent before the close and is still being handled is ignored.
   */
  disconnect(deviceId: string): void {
    const entry = this.connected.get(deviceId);
    this.connected.delete(deviceId);
    const latest = (this.broker as unknown as { clients?: Record<string, Client> } | undefined)
      ?.clients?.[deviceId];
    for (const client of [entry?.client, latest]) {
      if (client === undefined) continue;
      this.sessions.delete(client);
      client.close();
    }
  }

  /** PGR-007: marks pagers offline after three missed heartbeats. */
  async checkOffline(now: Date = this.clock.now()): Promise<number> {
    const online = await this.prisma.device.findMany({
      where: { type: 'PAGER', online: true, status: 'ACTIVE' },
      select: {
        id: true,
        restaurantId: true,
        staffId: true,
        lastSeenAt: true,
        batteryPercent: true,
      },
    });
    let changed = 0;
    for (const pager of online) {
      const settings = await this.notifications.settingsOf(pager.restaurantId);
      if (!pagerIsOffline(pager.lastSeenAt, now, settings.get('pagers.heartbeatSeconds'))) continue;
      await this.prisma.transaction(async (tx) => {
        await tx.device.update({ where: { id: pager.id }, data: { online: false } });
        await this.statusEvent(tx, pager.restaurantId, pager.id, pager.staffId, {
          online: false,
          batteryPercent: pager.batteryPercent,
        });
      });
      // PAGER-D6: a session that sends nothing is closed, so the pager signs in again; the list
      // of connected pagers then always matches the sessions (NTF-007).
      this.disconnect(pager.id);
      changed += 1;
    }
    return changed;
  }

  private async authenticate(
    client: Client,
    username: string | undefined,
    password: Buffer | undefined,
  ): Promise<'OK' | 'REFUSED' | 'BUSY'> {
    const address = addressOf(client);
    if (this.withWill.has(client)) {
      this.refusal('will-message', address);
      return 'REFUSED';
    }
    if (
      username === undefined ||
      password === undefined ||
      client.id !== username ||
      !DEVICE_ID.test(username)
    ) {
      this.refusal('not-a-pager', address);
      return 'REFUSED';
    }
    const device = await this.prisma.device.findUnique({
      where: { id: username },
      select: { restaurantId: true, type: true, status: true, staffId: true, mqttSecretHash: true },
    });
    if (device?.type !== 'PAGER' || device.status !== 'ACTIVE') {
      this.refusal('not-a-pager', address);
      return 'REFUSED';
    }
    const hash = device.mqttSecretHash;
    const secret = password.toString('utf8');
    // Peppered Argon2id, as for staff PINs (SEC-012): a stolen database does not give pager
    // secrets. A few checks at once, so a flood of sign-ins cannot take the PC's memory (PAGER-D3).
    const verified = await this.checks.run(() =>
      hash === null ? this.hasher.verifyNothing(secret) : this.hasher.verify(hash, secret),
    );
    if (verified === BUSY) {
      this.refusal('checks-busy', address);
      return 'BUSY';
    }
    if (!verified) {
      await this.signInFailed(username, address);
      return 'REFUSED';
    }
    if (client.closed) return 'REFUSED';
    this.sessions.set(client, {
      restaurantId: device.restaurantId,
      deviceId: client.id,
      staffId: device.staffId,
      address,
      lastBeatAtMs: null,
      acks: new TokenBucket(ACK_BURST, ACK_EVERY_MS, this.clockMs()),
    });
    if (client.conn instanceof LimitedConnection) {
      client.conn.signedIn(this.limits.maxPacketBytes);
    }
    return 'OK';
  }

  /** PAGER-R3: a wrong secret under a pager's name is logged and counted against the pager. */
  private async signInFailed(deviceId: string, address: string): Promise<void> {
    this.refusal('wrong-secret', address, deviceId);
    await this.prisma.device.update({
      where: { id: deviceId },
      data: { mqttSignInFailures: { increment: 1 }, mqttSignInFailedAt: this.clock.now() },
    });
  }

  private refusal(reason: Refusal, address: string, deviceId?: string): void {
    this.refusals.note(`${reason}|${address}|${deviceId ?? ''}`);
  }

  private async received(
    pager: PagerSession,
    topic: string,
    payload: Buffer | string,
  ): Promise<void> {
    const { deviceId } = pager;
    let body: unknown;
    try {
      body = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
    } catch {
      return;
    }
    if (topic === pagerTopic(pager.restaurantId, deviceId, 'heartbeat')) {
      const beat = PagerHeartbeat.safeParse(body);
      if (!beat.success) return;
      // PAGER-D4: not faster than half the interval, so a pager cannot keep the PC writing.
      const settings = await this.notifications.settingsOf(pager.restaurantId);
      const nowMs = this.clockMs();
      if (
        pagerHeartbeatTooSoon(pager.lastBeatAtMs, nowMs, settings.get('pagers.heartbeatSeconds'))
      ) {
        this.refusal('fast-heartbeats', pager.address, deviceId);
        return;
      }
      pager.lastBeatAtMs = nowMs;
      await this.heartbeat(pager, beat.data);
      return;
    }
    if (topic === pagerTopic(pager.restaurantId, deviceId, 'ack')) {
      const ack = PagerAckMessage.safeParse(body);
      if (!ack.success || pager.staffId === null) return;
      // Each acknowledgement is a transaction: a burst of a few, then about one a second.
      if (!pager.acks.take(this.clockMs())) {
        this.refusal('fast-acks', pager.address, deviceId);
        return;
      }
      // PAGER-T1, PAGER-R2: only an alert sent to this pager, recorded as coming from it.
      await this.notifications
        .acknowledgeForPager(
          { restaurantId: pager.restaurantId, deviceId, staffId: pager.staffId },
          ack.data.alertId,
        )
        .catch(() => undefined);
    }
  }

  private async heartbeat(pager: ConnectedPager, beat: PagerHeartbeat): Promise<void> {
    const now = this.clock.now();
    const settings = await this.notifications.settingsOf(pager.restaurantId);
    const threshold = settings.get('pager.lowBatteryPercent');
    await this.prisma.transaction(async (tx) => {
      const before = await tx.device.findUniqueOrThrow({
        where: { id: pager.deviceId },
        select: { online: true, batteryPercent: true },
      });
      await tx.device.update({
        where: { id: pager.deviceId },
        data: {
          online: true,
          lastSeenAt: now,
          batteryPercent: beat.battery,
          rssi: beat.rssi,
          firmwareVersion: beat.firmware,
          charging: beat.charging ?? false,
        },
      });
      const wasLow = isLowBattery(before.batteryPercent, threshold);
      const isLow = isLowBattery(beat.battery, threshold);
      // Only a change of state is news (Appendix C: once per state change).
      if (!before.online || wasLow !== isLow) {
        await this.statusEvent(tx, pager.restaurantId, pager.deviceId, pager.staffId, {
          online: true,
          batteryPercent: beat.battery,
        });
      }
    });
    for (const listener of this.heartbeatListeners) {
      await listener(pager, beat).catch((error: unknown) => {
        this.logger.error(`A pager heartbeat listener failed: ${String(error)}`);
      });
    }
  }

  /** Managers see every pager's status; the wearer hears about their own (WTR-014). */
  private async statusEvent(
    tx: TransactionClient,
    restaurantId: string,
    deviceId: string,
    wearerId: string | null,
    { online, batteryPercent }: { online: boolean; batteryPercent: number | null },
  ): Promise<void> {
    const now = this.clock.now();
    await appendEvent(
      tx,
      {
        eventId: newId(),
        type: 'DeviceStatusChanged',
        version: 1,
        occurredAt: now.toISOString(),
        restaurantId,
        businessDate: await currentBusinessDate(tx, restaurantId, now),
        payload: {
          deviceId,
          deviceType: 'PAGER',
          online,
          ...(batteryPercent !== null && { batteryPercent }),
        },
      },
      {
        aggregate: { type: 'device', id: deviceId },
        ...(wearerId !== null && { audience: { staffIds: [wearerId] } }),
      },
    );
  }

  /** Alert events → the recipients' pagers. */
  private async deliver({ event }: PublishedEvent): Promise<void> {
    if (this.broker === undefined) return;
    if (
      event.type !== 'AlertRaised' &&
      event.type !== 'AlertAcknowledged' &&
      event.type !== 'AlertCleared'
    ) {
      return;
    }
    const recipients = new Set(event.payload.recipients);
    const wearers = this.connectedPagers().filter(
      (pager) =>
        pager.restaurantId === event.restaurantId &&
        pager.staffId !== null &&
        recipients.has(pager.staffId),
    );
    if (wearers.length === 0) return;
    const alert = await this.prisma.alert.findUnique({ where: { id: event.payload.alertId } });
    if (alert === null) return;
    // The pager shows what the waiter app shows (WTR-006): the rule's pager and app alerts.
    const targets = wearers.filter(
      (pager) => pager.staffId !== null && reachesPagerAndApp(alert, pager.staffId),
    );
    if (targets.length === 0) return;
    const settings = await this.notifications.settingsOf(event.restaurantId);
    const message: PagerAlertMessage = {
      alertId: alert.id,
      seq: alert.repeatCount,
      state:
        event.type === 'AlertRaised'
          ? 'ALERT'
          : event.type === 'AlertAcknowledged'
            ? 'ACKNOWLEDGED'
            : 'CLEARED',
      type: alert.type as NotificationEventType,
      lines: pagerLines(alert.pagerText ?? ''),
      vibration: vibrationFor(
        alert.type as NotificationEvent,
        alert.escalatedAt !== null,
        settings.get('pagers.vibration'),
      ),
      sentAt: this.clock.now().toISOString(),
    };
    for (const pager of targets) await this.publish(pager, message);
  }

  /** PGR-008: after (re)connecting, the wearer's open alerts are sent again. */
  private async resend(deviceId: string): Promise<void> {
    const pager = this.connected.get(deviceId)?.pager;
    const staffId = pager?.staffId ?? null;
    if (pager === undefined || staffId === null) return;
    const open: AlertListResponse['alerts'] = (
      await this.notifications.list({
        restaurantId: pager.restaurantId,
        staffId,
        role: 'WAITER',
      })
    ).alerts.filter((alert) => reachesPagerAndApp(alert, staffId));
    const settings = await this.notifications.settingsOf(pager.restaurantId);
    for (const alert of open) {
      await this.publish(pager, {
        alertId: alert.id,
        seq: alert.repeatCount,
        state: 'ALERT',
        type: alert.type,
        lines: pagerLines(alert.pagerText ?? ''),
        vibration: vibrationFor(
          alert.type,
          alert.escalatedAt !== null,
          settings.get('pagers.vibration'),
        ),
        sentAt: this.clock.now().toISOString(),
      });
    }
  }

  private publish(pager: ConnectedPager, message: PagerAlertMessage): Promise<void> {
    return this.publishTo(pager, 'alerts', message);
  }

  private publishTo(
    pager: ConnectedPager,
    kind: 'alerts' | 'ota',
    message: PagerAlertMessage | PagerFirmwareOffer,
  ): Promise<void> {
    const broker = this.broker;
    if (broker === undefined) return Promise.resolve();
    return new Promise((resolve, reject) => {
      broker.publish(
        {
          cmd: 'publish',
          topic: pagerTopic(pager.restaurantId, pager.deviceId, kind),
          payload: Buffer.from(JSON.stringify(message)),
          qos: 1,
          retain: false,
          dup: false,
        },
        (error) => {
          if (error) reject(error);
          else resolve();
        },
      );
    });
  }
}
