import { createServer as createNetServer, type Server as NetServer } from 'node:net';
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
  PagerHeartbeat,
} from '@rp/contracts';
import {
  type NotificationEvent,
  pagerIsOffline,
  pagerLines,
  pagerMayPublish,
  pagerMaySubscribe,
  pagerTopic,
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

export const PAGER_OPTIONS = Symbol('PAGER_OPTIONS');

export interface PagerOptions {
  /** How often pagers are checked for missed heartbeats (0: never; tests call it). */
  readonly offlineCheckMs: number;
}

export const DEFAULT_PAGER_OPTIONS: PagerOptions = { offlineCheckMs: 10_000 };

interface ConnectedPager {
  readonly restaurantId: string;
  readonly deviceId: string;
  staffId: string | null;
}

const NOT_AUTHORIZED = 5;

function refused(): AuthenticateError {
  return Object.assign(new Error('Bad pager credential'), { returnCode: NOT_AUTHORIZED });
}

/**
 * The pagers' MQTT broker (P2-04, PGR-005, PGR-007, PGR-008, SEC-012), embedded in the server:
 * - MQTTS with the installation's certificate when TLS is on (ADR-0011);
 * - each pager signs in with its own credential (client id = user name = its device id);
 * - it may subscribe only to its own alerts topic and publish only its own ack and heartbeat;
 * - alerts reach the wearer's pager at QoS 1, and a reconnecting pager is sent every open alert of
 *   its wearer again (it de-duplicates by alert id and repeat number);
 * - heartbeats keep battery, signal and firmware; three missed heartbeats mark it offline.
 */
@Injectable()
export class PagerBroker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PagerBroker.name);
  private broker: Aedes | undefined;
  private server: NetServer | TlsServer | undefined;
  private readonly connected = new Map<string, ConnectedPager>();
  private unsubscribe: (() => void) | undefined;
  private stopRenewals: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopPresence: (() => void) | undefined;

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
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.mqtt === 'off') return;
    const broker = await Aedes.createBroker({
      authenticate: (client, username, password, done) => {
        this.authenticate(client, username, password).then(
          (ok) => {
            done(ok ? null : refused(), ok);
          },
          (error: unknown) => {
            this.logger.error(`Pager sign-in failed: ${String(error)}`);
            done(refused(), false);
          },
        );
      },
      authorizeSubscribe: (client, subscription, done) => {
        const pager = this.connected.get(client.id);
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
        const pager = this.connected.get(client.id);
        done(
          pager !== undefined && pagerMayPublish(packet.topic, pager.restaurantId, pager.deviceId)
            ? null
            : new Error('Not your topic'),
        );
      },
    });
    broker.on('publish', (packet, client) => {
      if (client === null) return;
      void this.received(client.id, packet.topic, packet.payload).catch((error: unknown) => {
        this.logger.error(`Pager message failed: ${String(error)}`);
      });
    });
    broker.on('clientReady', (client) => {
      void this.resend(client.id).catch((error: unknown) => {
        this.logger.error(`Could not resend alerts to a pager: ${String(error)}`);
      });
    });
    broker.on('clientDisconnect', (client) => {
      this.connected.delete(client.id);
    });
    this.broker = broker;
    this.stopPresence = this.presence.add((restaurantId, staffId) =>
      this.isStaffConnected(restaurantId, staffId),
    );
    const tlsOptions = await this.tls.listenerOptions();
    let server: NetServer | TlsServer;
    if (tlsOptions === undefined) {
      server = createNetServer(broker.handle);
    } else {
      const secure = createTlsServer(tlsOptions, broker.handle);
      this.stopRenewals = this.tls.onRenewed((options) => {
        secure.setSecureContext(options);
      });
      server = secure;
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.mqttPort, this.config.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.unsubscribe = this.bus.onPublished((events) => {
      for (const published of events)
        void this.deliver(published).catch((error: unknown) => {
          this.logger.error(`Pager delivery failed: ${String(error)}`);
        });
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
    for (const pager of this.connected.values()) {
      if (pager.restaurantId === restaurantId && pager.staffId === staffId) return true;
    }
    return false;
  }

  /** A pager changed hands (PGR-012): route to the new wearer and send them the open alerts. */
  async reassigned(deviceId: string, staffId: string | null): Promise<void> {
    const pager = this.connected.get(deviceId);
    if (pager === undefined) return;
    pager.staffId = staffId;
    await this.resend(deviceId);
  }

  /** Drops a pager's connection (its credential was replaced or it was revoked). */
  disconnect(deviceId: string): void {
    this.connected.delete(deviceId);
    const client = (this.broker as unknown as { clients?: Record<string, Client> } | undefined)
      ?.clients?.[deviceId];
    client?.close();
  }

  /** PGR-007: marks pagers offline after three missed heartbeats. */
  async checkOffline(now: Date = this.clock.now()): Promise<number> {
    const online = await this.prisma.device.findMany({
      where: { type: 'PAGER', online: true },
      select: { id: true, restaurantId: true, lastSeenAt: true, batteryPercent: true },
    });
    let changed = 0;
    for (const pager of online) {
      const settings = await this.notifications.settingsOf(pager.restaurantId);
      if (!pagerIsOffline(pager.lastSeenAt, now, settings.get('pagers.heartbeatSeconds'))) continue;
      await this.prisma.transaction(async (tx) => {
        await tx.device.update({ where: { id: pager.id }, data: { online: false } });
        await this.statusEvent(tx, pager.restaurantId, pager.id, false, pager.batteryPercent);
      });
      this.connected.delete(pager.id);
      changed += 1;
    }
    return changed;
  }

  private async authenticate(
    client: Client,
    username: string | undefined,
    password: Buffer | undefined,
  ): Promise<boolean> {
    if (username === undefined || password === undefined || client.id !== username) return false;
    if (!/^[0-9a-f-]{36}$/.test(username)) return false;
    const device = await this.prisma.device.findUnique({
      where: { id: username },
      select: { restaurantId: true, type: true, status: true, staffId: true, mqttSecretHash: true },
    });
    if (device?.type !== 'PAGER' || device.status !== 'ACTIVE') return false;
    // Peppered Argon2id, as for staff PINs (SEC-012): a stolen database does not give pager secrets.
    if (device.mqttSecretHash === null) {
      await this.hasher.verifyNothing(password.toString('utf8'));
      return false;
    }
    if (!(await this.hasher.verify(device.mqttSecretHash, password.toString('utf8')))) return false;
    this.connected.set(client.id, {
      restaurantId: device.restaurantId,
      deviceId: client.id,
      staffId: device.staffId,
    });
    return true;
  }

  private async received(deviceId: string, topic: string, payload: Buffer | string): Promise<void> {
    const pager = this.connected.get(deviceId);
    if (pager === undefined) return;
    let body: unknown;
    try {
      body = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
    } catch {
      return;
    }
    if (topic === pagerTopic(pager.restaurantId, deviceId, 'heartbeat')) {
      const beat = PagerHeartbeat.safeParse(body);
      if (beat.success) await this.heartbeat(pager, beat.data);
      return;
    }
    if (topic === pagerTopic(pager.restaurantId, deviceId, 'ack')) {
      const ack = PagerAckMessage.safeParse(body);
      if (!ack.success || pager.staffId === null) return;
      const staff = await this.prisma.staff.findUnique({
        where: { id: pager.staffId },
        select: { role: { select: { baseRole: true } } },
      });
      if (staff === null) return;
      await this.notifications
        .acknowledge(
          {
            restaurantId: pager.restaurantId,
            staffId: pager.staffId,
            role: staff.role.baseRole,
          },
          ack.data.alertId,
        )
        .catch(() => undefined);
    }
  }

  private async heartbeat(pager: ConnectedPager, beat: PagerHeartbeat): Promise<void> {
    const now = this.clock.now();
    const settings = await this.notifications.settingsOf(pager.restaurantId);
    const threshold = settings.get('notifications.lowBatteryPercent');
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
        },
      });
      const wasLow = before.batteryPercent !== null && before.batteryPercent <= threshold;
      const isLow = beat.battery <= threshold;
      // Only a change of state is news (Appendix C: once per state change).
      if (!before.online || wasLow !== isLow) {
        await this.statusEvent(tx, pager.restaurantId, pager.deviceId, true, beat.battery);
      }
    });
  }

  private async statusEvent(
    tx: TransactionClient,
    restaurantId: string,
    deviceId: string,
    online: boolean,
    batteryPercent: number | null,
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
      { aggregate: { type: 'device', id: deviceId } },
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
    const targets = [...this.connected.values()].filter(
      (pager) =>
        pager.restaurantId === event.restaurantId &&
        pager.staffId !== null &&
        recipients.has(pager.staffId),
    );
    if (targets.length === 0) return;
    const alert = await this.prisma.alert.findUnique({ where: { id: event.payload.alertId } });
    if (alert === null) return;
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
    const pager = this.connected.get(deviceId);
    const staffId = pager?.staffId ?? null;
    if (pager === undefined || staffId === null) return;
    const open: AlertListResponse['alerts'] = (
      await this.notifications.list({
        restaurantId: pager.restaurantId,
        staffId,
        role: 'WAITER',
      })
    ).alerts;
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
    const broker = this.broker;
    if (broker === undefined) return Promise.resolve();
    return new Promise((resolve, reject) => {
      broker.publish(
        {
          cmd: 'publish',
          topic: pagerTopic(pager.restaurantId, pager.deviceId, 'alerts'),
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
