import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  CreatePagerRequest,
  MyPagerResponse,
  PagerCredentialResponse,
  PagerListResponse,
  PagerView,
} from '@rp/contracts';
import { pagerTopic } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { newId } from '../common/ids.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import type { Device } from '../generated/prisma/client.js';
import { AppError } from '../errors/app-error.js';
import { CredentialHasher } from '../auth/credential-hasher.js';
import { announceSetupChange } from '../restaurant/setup-changes.js';
import { SettingsService } from '../settings/settings.service.js';
import { PagerBroker } from './pager-broker.js';

function view(device: Device): PagerView {
  return {
    deviceId: device.id,
    name: device.name,
    serial: device.serial,
    staffId: device.staffId,
    online: device.online,
    batteryPercent: device.batteryPercent,
    rssi: device.rssi,
    firmwareVersion: device.firmwareVersion,
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
  };
}

/**
 * Pager administration for managers (P2-04, PGR-012, PGR-014, SEC-012): register a pager from its
 * serial with a unique credential (shown once, stored as a peppered Argon2id hash), replace the
 * credential, and give the pager to a person or take it back, effective at once. Every change is
 * announced as `RestaurantChanged` `DEVICES` (P4-02b), so pager lists and the wearer's own pager
 * follow it.
 */
@Injectable()
export class PagersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly broker: PagerBroker,
    private readonly hasher: CredentialHasher,
    private readonly settings: SettingsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(restaurantId: string): Promise<PagerListResponse> {
    const [pagers, settings] = await Promise.all([
      this.prisma.device.findMany({
        where: { restaurantId, type: 'PAGER', status: 'ACTIVE' },
        orderBy: { name: 'asc' },
      }),
      this.settings.snapshot(restaurantId),
    ]);
    return {
      pagers: pagers.map(view),
      lowBatteryPercent: settings.get('pager.lowBatteryPercent'),
    };
  }

  /** WTR-014: the pager the person wears (a person wears at most one, PGR-012), if any. */
  async mine(principal: Principal): Promise<MyPagerResponse> {
    const [pager, settings] = await Promise.all([
      this.prisma.device.findFirst({
        where: {
          restaurantId: principal.restaurantId,
          type: 'PAGER',
          status: 'ACTIVE',
          staffId: principal.staffId,
        },
      }),
      this.settings.snapshot(principal.restaurantId),
    ]);
    return {
      pager: pager === null ? null : view(pager),
      lowBatteryPercent: settings.get('pager.lowBatteryPercent'),
    };
  }

  async create(
    principal: Principal,
    request: CreatePagerRequest,
  ): Promise<PagerCredentialResponse> {
    const secret = randomBytes(24).toString('base64url');
    const secretHash = await this.hasher.hash(secret);
    const device = await this.prisma.transaction(async (tx) => {
      const clash = await tx.device.findFirst({
        where: {
          restaurantId: principal.restaurantId,
          type: 'PAGER',
          status: 'ACTIVE',
          serial: request.serial,
        },
        select: { id: true },
      });
      if (clash !== null) {
        throw new AppError(409, 'PAGER_ALREADY_REGISTERED', 'This pager is already registered.');
      }
      if (request.staffId !== null) await this.releaseWearer(tx, principal, request.staffId);
      const created = await tx.device.create({
        data: {
          id: newId(),
          restaurantId: principal.restaurantId,
          type: 'PAGER',
          name: request.name,
          serial: request.serial,
          status: 'ACTIVE',
          pairedAt: new Date(),
          pairedById: principal.staffId,
          staffId: request.staffId,
          mqttSecretHash: secretHash,
        },
      });
      await this.record(tx, principal, 'PAGER_REGISTERED', created.id, null, {
        serial: request.serial,
        name: request.name,
        staffId: request.staffId,
      });
      await this.announce(tx, principal, created.id);
      return created;
    });
    return this.credential(device, secret);
  }

  async rotate(principal: Principal, deviceId: string): Promise<PagerCredentialResponse> {
    const secret = randomBytes(24).toString('base64url');
    const secretHash = await this.hasher.hash(secret);
    const device = await this.prisma.transaction(async (tx) => {
      await this.find(tx, principal.restaurantId, deviceId);
      const updated = await tx.device.update({
        where: { id: deviceId },
        data: { mqttSecretHash: secretHash },
      });
      await this.record(tx, principal, 'PAGER_CREDENTIAL_REPLACED', deviceId, null, null);
      await this.announce(tx, principal, deviceId);
      return updated;
    });
    this.broker.disconnect(deviceId);
    return this.credential(device, secret);
  }

  async assign(principal: Principal, deviceId: string, staffId: string | null): Promise<PagerView> {
    const device = await this.prisma.transaction(async (tx) => {
      const existing = await this.find(tx, principal.restaurantId, deviceId);
      if (existing.staffId === staffId) return existing;
      if (staffId !== null) await this.releaseWearer(tx, principal, staffId, deviceId);
      const updated = await tx.device.update({ where: { id: deviceId }, data: { staffId } });
      await this.record(
        tx,
        principal,
        'PAGER_ASSIGNED',
        deviceId,
        { staffId: existing.staffId },
        { staffId },
      );
      await this.announce(tx, principal, deviceId);
      return updated;
    });
    await this.broker.reassigned(deviceId, staffId);
    return view(device);
  }

  /** A person wears one pager: giving them this one takes any other from them. */
  private async releaseWearer(
    tx: TransactionClient,
    principal: Principal,
    staffId: string,
    exceptDeviceId?: string,
  ): Promise<void> {
    const person = await tx.staff.findFirst({
      where: { id: staffId, restaurantId: principal.restaurantId, active: true, archivedAt: null },
      select: { id: true },
    });
    if (person === null) {
      throw new AppError(422, 'STAFF_NOT_FOUND', 'Choose a person who works here and is active.');
    }
    const others = await tx.device.findMany({
      where: {
        restaurantId: principal.restaurantId,
        type: 'PAGER',
        staffId,
        ...(exceptDeviceId !== undefined && { NOT: { id: exceptDeviceId } }),
      },
      select: { id: true },
    });
    for (const other of others) {
      await tx.device.update({ where: { id: other.id }, data: { staffId: null } });
      await this.record(tx, principal, 'PAGER_ASSIGNED', other.id, { staffId }, { staffId: null });
      await this.broker.reassigned(other.id, null);
    }
  }

  private async find(
    tx: TransactionClient,
    restaurantId: string,
    deviceId: string,
  ): Promise<Device> {
    const device = await tx.device.findFirst({
      where: { id: deviceId, restaurantId, type: 'PAGER', status: 'ACTIVE' },
    });
    if (device === null) throw new AppError(404, 'PAGER_NOT_FOUND', 'There is no such pager.');
    return device;
  }

  private credential(device: Device, secret: string): PagerCredentialResponse {
    return {
      deviceId: device.id,
      mqttUsername: device.id,
      mqttPassword: secret,
      alertsTopic: pagerTopic(device.restaurantId, device.id, 'alerts'),
      locateTopic: pagerTopic(device.restaurantId, device.id, 'locate'),
      ackTopic: pagerTopic(device.restaurantId, device.id, 'ack'),
      heartbeatTopic: pagerTopic(device.restaurantId, device.id, 'heartbeat'),
      mqttPort: this.broker.port() ?? (this.config.mqttPort || 8883),
    };
  }

  private announce(tx: TransactionClient, principal: Principal, deviceId: string): Promise<void> {
    return announceSetupChange(tx, principal.restaurantId, 'DEVICES', {
      type: 'device',
      id: deviceId,
    });
  }

  private async record(
    tx: TransactionClient,
    principal: Principal,
    action: string,
    deviceId: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await this.audit.record(tx, {
      action,
      entityType: 'device',
      entityId: deviceId,
      actorId: principal.staffId,
      deviceId: principal.deviceId,
      restaurantId: principal.restaurantId,
      before,
      after,
      reason: null,
    });
  }
}
