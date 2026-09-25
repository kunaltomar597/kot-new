import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  type CreatePairingCodeRequest,
  type DeviceChallengeResponse,
  type DeviceListResponse,
  type DeviceSummary,
  type DeviceTokenRequest,
  type DeviceTokenResponse,
  deviceTokenMessage,
  type PairDeviceRequest,
  type PairedDevice,
  type PairingCodeResponse,
  pairingProofMessage,
} from '@rp/contracts';
import { businessDateOf } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import { AuthSettingsService } from '../auth/auth-settings.js';
import {
  isDeviceKeyAlgorithm,
  parseDevicePublicKey,
  verifyDeviceSignature,
} from '../auth/device-keys.js';
import { DeviceTokenService } from '../auth/device-token.service.js';
import type { Principal } from '../auth/principal.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { sha256Hex } from '../auth/tokens.js';
import { newId } from '../common/ids.js';
import { ADVISORY_LOCKS } from '../database/advisory-locks.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { appendEvent } from '../events/outbox.js';
import type { Prisma } from '../generated/prisma/client.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const errors = {
  codeInvalid: () =>
    new AppError(
      401,
      'PAIRING_CODE_INVALID',
      'This pairing code is not valid any more. Ask a manager for a new code.',
    ),
  proofInvalid: () =>
    new AppError(
      401,
      'PAIRING_PROOF_INVALID',
      'The device key could not be verified. Try pairing again.',
    ),
  deviceAuthFailed: () =>
    new AppError(
      401,
      'DEVICE_AUTH_FAILED',
      'This device could not prove its identity. If it was unpaired, ask a manager to pair it again.',
    ),
  rateLimited: () =>
    new AppError(
      429,
      'RATE_LIMITED',
      'Too many attempts from this device. Wait a minute and try again.',
    ),
  notFound: () => AppError.notFound('The device'),
  tableNotFound: () =>
    new AppError(
      422,
      'TABLE_NOT_FOUND',
      'That table does not exist. Choose a table from the floor plan.',
    ),
  bindingNotFound: (what: string) =>
    new AppError(422, 'BINDING_NOT_FOUND', `That ${what} does not exist. Choose another one.`),
  notATablet: () =>
    new AppError(409, 'NOT_A_TABLE_TABLET', 'Only table tablets are bound to a table.'),
  deviceRevoked: () =>
    new AppError(409, 'DEVICE_REVOKED', 'This device is unpaired. Pair it again first.'),
  ownDevice: () =>
    new AppError(
      409,
      'CANNOT_REVOKE_OWN_DEVICE',
      'You cannot unpair the device you are using. Unpair it from another device.',
    ),
  bootstrapClosed: () =>
    new AppError(
      403,
      'BOOTSTRAP_CLOSED',
      'A device is already paired. Pair new devices from the manager screen.',
    ),
  notSetUp: () =>
    new AppError(
      409,
      'RESTAURANT_NOT_SET_UP',
      'The restaurant is not set up yet. Finish setup first.',
    ),
};

function pairingCode(): string {
  const pick = () => CODE_ALPHABET.charAt(randomInt(CODE_ALPHABET.length));
  const half = () => Array.from({ length: 4 }, pick).join('');
  return `${half()}-${half()}`;
}

type DeviceRow = Prisma.DeviceGetPayload<Record<string, never>>;
type PairOutcome = { readonly error: AppError } | { readonly device: DeviceRow };

function summary(device: DeviceRow): DeviceSummary {
  return {
    id: device.id,
    type: device.type,
    name: device.name,
    status: device.status,
    tableId: device.tableId,
    stationId: device.stationId,
    staffId: device.staffId,
    pairedAt: device.pairedAt?.toISOString() ?? null,
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    appVersion: device.appVersion,
  };
}

/**
 * Pairing and managing devices (AUTH-007 to AUTH-009). A manager creates a one-time code; the
 * device pairs with it and its public key; afterwards it authenticates by signing challenges.
 */
@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: DeviceTokenService,
    private readonly settings: AuthSettingsService,
    private readonly audit: AuditService,
    private readonly limiter: RateLimiter,
  ) {}

  async createPairingCode(
    principal: Principal,
    request: CreatePairingCodeRequest,
  ): Promise<PairingCodeResponse> {
    return this.prisma.transaction(async (tx) => {
      await this.checkBinding(tx, principal.restaurantId, request);
      return this.issueCode(
        tx,
        principal.restaurantId,
        request,
        principal.staffId,
        principal.deviceId,
      );
    });
  }

  /**
   * The installer pairs the POS on the server PC with this code (ONB-001). Only from the server PC
   * itself and only while no device is paired, so it cannot be used to add devices later.
   */
  async createBootstrapCode(loopback: boolean): Promise<PairingCodeResponse> {
    if (!loopback) throw errors.bootstrapClosed();
    return this.prisma.transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${ADVISORY_LOCKS.pairingBootstrap})`;
      if ((await tx.device.count({ where: { status: 'ACTIVE' } })) > 0) {
        throw errors.bootstrapClosed();
      }
      const restaurant = await tx.restaurant.findFirst({ orderBy: { createdAt: 'asc' } });
      if (restaurant === null) throw errors.notSetUp();
      return this.issueCode(tx, restaurant.id, { type: 'POS', name: 'Server POS' }, null, null);
    });
  }

  async pair(request: PairDeviceRequest, clientKey: string): Promise<PairedDevice> {
    this.throttle(`pair:${clientKey}`, 10);
    const now = new Date();
    const outcome = await this.prisma.transaction(async (tx): Promise<PairOutcome> => {
      const codeHash = sha256Hex(request.code);
      await tx.$queryRaw`SELECT 1 AS locked FROM pairing_codes WHERE code_hash = ${codeHash} FOR UPDATE`;
      const code = await tx.pairingCode.findUnique({ where: { codeHash } });
      if (code?.usedAt !== null || code.expiresAt <= now) {
        return { error: errors.codeInvalid() };
      }
      const key = parseDevicePublicKey(request.algorithm, request.publicKey);
      const proofOk =
        key !== undefined &&
        verifyDeviceSignature(
          request.algorithm,
          key,
          pairingProofMessage(request.code),
          request.proof,
        );
      if (key === undefined || !proofOk) return { error: errors.proofInvalid() };

      const device = await tx.device.create({
        data: {
          id: newId(),
          restaurantId: code.restaurantId,
          type: code.type,
          name: code.name,
          status: 'ACTIVE',
          publicKey: key.export({ format: 'pem', type: 'spki' }).toString(),
          keyAlgorithm: request.algorithm,
          pairedAt: now,
          pairedById: code.createdById,
          appVersion: request.appVersion ?? null,
          tableId: code.tableId,
          stationId: code.stationId,
          staffId: code.staffId,
        },
      });
      await tx.pairingCode.update({
        where: { id: code.id },
        data: { usedAt: now, deviceId: device.id },
      });
      await this.audit.record(tx, {
        action: 'DEVICE_PAIRED',
        entityType: 'device',
        entityId: device.id,
        actorId: code.createdById,
        deviceId: device.id,
        restaurantId: code.restaurantId,
        after: {
          type: device.type,
          name: device.name,
          tableId: device.tableId,
          stationId: device.stationId,
          staffId: device.staffId,
          keyAlgorithm: request.algorithm,
        },
      });
      return { device };
    });
    if ('error' in outcome) throw outcome.error;
    const { device } = outcome;
    return {
      deviceId: device.id,
      restaurantId: device.restaurantId,
      type: device.type,
      name: device.name,
      tableId: device.tableId,
      stationId: device.stationId,
      staffId: device.staffId,
    };
  }

  /** A challenge is handed out for any device id; only the device's key can use it. */
  challenge(deviceId: string, clientKey: string): DeviceChallengeResponse {
    this.throttle(`device-auth:${clientKey}`, 60);
    this.throttle(`device-auth:${deviceId}`, 30);
    const { challenge, expiresAt } = this.tokens.createChallenge(deviceId);
    return { challenge, expiresAt: expiresAt.toISOString() };
  }

  async issueToken(request: DeviceTokenRequest, clientKey: string): Promise<DeviceTokenResponse> {
    this.throttle(`device-auth:${clientKey}`, 60);
    this.throttle(`device-auth:${request.deviceId}`, 30);
    if (!this.tokens.consumeChallenge(request.challenge, request.deviceId)) {
      throw errors.deviceAuthFailed();
    }
    const device = await this.prisma.device.findFirst({
      where: { id: request.deviceId, status: 'ACTIVE' },
    });
    const publicKey = device?.publicKey ?? null;
    if (device === null || publicKey === null || !isDeviceKeyAlgorithm(device.keyAlgorithm)) {
      throw errors.deviceAuthFailed();
    }
    const message = deviceTokenMessage(request.deviceId, request.challenge);
    if (!verifyDeviceSignature(device.keyAlgorithm, publicKey, message, request.signature)) {
      throw errors.deviceAuthFailed();
    }
    const settings = await this.settings.get(device.restaurantId);
    const now = new Date();
    const { token, expiresAt } = await this.tokens.sign(
      { deviceId: device.id, restaurantId: device.restaurantId },
      settings.deviceTokenMinutes * 60,
      now,
    );
    await this.prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: now } });
    return { deviceToken: token, expiresAt: expiresAt.toISOString() };
  }

  async list(principal: Principal): Promise<DeviceListResponse> {
    const devices = await this.prisma.device.findMany({
      where: { restaurantId: principal.restaurantId },
      orderBy: { createdAt: 'asc' },
    });
    return { devices: devices.map(summary) };
  }

  /**
   * Unpairs a device (AUTH-008): its device token and every staff session on it stop working at
   * the next request, and a `DeviceRevoked` event tells the real-time gateway (P0-12) to close
   * its connections.
   */
  async revoke(principal: Principal, deviceId: string, reason: string): Promise<DeviceSummary> {
    if (deviceId === principal.deviceId) throw errors.ownDevice();
    return this.prisma.transaction(async (tx) => {
      const device = await tx.device.findFirst({
        where: { id: deviceId, restaurantId: principal.restaurantId },
      });
      if (device === null) throw errors.notFound();
      if (device.status === 'REVOKED') return summary(device);
      const now = new Date();
      const revoked = await tx.device.update({
        where: { id: device.id },
        data: { status: 'REVOKED', revokedAt: now },
      });
      const sessions = await tx.session.updateMany({
        where: { deviceId: device.id, revokedAt: null },
        data: { revokedAt: now, revokeReason: 'DEVICE_REVOKED' },
      });
      const restaurant = await tx.restaurant.findUniqueOrThrow({
        where: { id: principal.restaurantId },
      });
      await appendEvent(
        tx,
        {
          eventId: newId(),
          type: 'DeviceRevoked',
          version: 1,
          occurredAt: now.toISOString(),
          restaurantId: principal.restaurantId,
          businessDate: businessDateOf(now, {
            cutoff: restaurant.businessDayCutoff,
            timeZone: restaurant.timeZone,
          }),
          payload: { deviceId: device.id, deviceType: device.type, reason },
        },
        { aggregate: { type: 'device', id: device.id } },
      );
      await this.audit.record(tx, {
        action: 'DEVICE_REVOKED',
        entityType: 'device',
        entityId: device.id,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        before: { status: device.status },
        after: { status: 'REVOKED', sessionsRevoked: sessions.count },
        reason,
      });
      return summary(revoked);
    });
  }

  /** Moves a table tablet to another table (AUTH-009); needs a manager. */
  async bindTable(principal: Principal, deviceId: string, tableId: string): Promise<DeviceSummary> {
    return this.prisma.transaction(async (tx) => {
      const device = await tx.device.findFirst({
        where: { id: deviceId, restaurantId: principal.restaurantId },
      });
      if (device === null) throw errors.notFound();
      if (device.type !== 'TABLE_TABLET') throw errors.notATablet();
      if (device.status !== 'ACTIVE') throw errors.deviceRevoked();
      const table = await tx.diningTable.findFirst({
        where: { id: tableId, restaurantId: principal.restaurantId, archivedAt: null },
      });
      if (table === null) throw errors.tableNotFound();
      const updated = await tx.device.update({ where: { id: device.id }, data: { tableId } });
      await this.audit.record(tx, {
        action: 'DEVICE_TABLE_CHANGED',
        entityType: 'device',
        entityId: device.id,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        before: { tableId: device.tableId },
        after: { tableId },
      });
      return summary(updated);
    });
  }

  private async checkBinding(
    tx: TransactionClient,
    restaurantId: string,
    request: CreatePairingCodeRequest,
  ): Promise<void> {
    if (request.tableId !== undefined) {
      const table = await tx.diningTable.findFirst({
        where: { id: request.tableId, restaurantId, archivedAt: null },
      });
      if (table === null) throw errors.tableNotFound();
    }
    if (request.stationId !== undefined) {
      const station = await tx.station.findFirst({
        where: { id: request.stationId, restaurantId, archivedAt: null },
      });
      if (station === null) throw errors.bindingNotFound('station');
    }
    if (request.staffId !== undefined) {
      const staff = await tx.staff.findFirst({
        where: { id: request.staffId, restaurantId, active: true, archivedAt: null },
      });
      if (staff === null) throw errors.bindingNotFound('staff member');
    }
  }

  private async issueCode(
    tx: TransactionClient,
    restaurantId: string,
    request: Pick<CreatePairingCodeRequest, 'type' | 'name' | 'tableId' | 'stationId' | 'staffId'>,
    createdById: string | null,
    actorDeviceId: string | null,
  ): Promise<PairingCodeResponse> {
    const settings = await this.settings.get(restaurantId);
    const code = pairingCode();
    const expiresAt = new Date(Date.now() + settings.pairingCodeMinutes * 60_000);
    const created = await tx.pairingCode.create({
      data: {
        restaurantId,
        codeHash: sha256Hex(code),
        type: request.type,
        name: request.name,
        tableId: request.tableId ?? null,
        stationId: request.stationId ?? null,
        staffId: request.staffId ?? null,
        createdById,
        expiresAt,
      },
    });
    await this.audit.record(tx, {
      action: 'DEVICE_PAIRING_CODE_CREATED',
      entityType: 'pairing_code',
      entityId: created.id,
      actorId: createdById,
      deviceId: actorDeviceId,
      restaurantId,
      after: {
        type: request.type,
        name: request.name,
        tableId: request.tableId ?? null,
        expiresAt,
      },
      ...(createdById === null && { reason: 'Bootstrap code for the POS on the server PC' }),
    });
    return {
      code,
      expiresAt: expiresAt.toISOString(),
      qrPayload: JSON.stringify({ v: 1, code }),
    };
  }

  private throttle(key: string, limit: number): void {
    if (!this.limiter.attempt(key, limit, 60_000)) throw errors.rateLimited();
  }
}
