import { Injectable } from '@nestjs/common';
import { DEVICE_TOKEN_HEADER } from '@rp/contracts';
import type { Request } from 'express';
import { PrismaService } from '../database/prisma.service.js';
import type { AuthenticatedDevice, DeviceAuthenticator } from './device.js';
import { DeviceTokenService } from './device-token.service.js';

/** `last_seen_at` is written at most this often per device. */
const SEEN_INTERVAL_MS = 60_000;

/**
 * Recognises a paired device from its device token (AUTH-007). The device row is checked on
 * every request, so unpairing takes effect at once (AUTH-008).
 */
@Injectable()
export class DeviceTokenAuthenticator implements DeviceAuthenticator {
  constructor(
    private readonly tokens: DeviceTokenService,
    private readonly prisma: PrismaService,
  ) {}

  async authenticate(request: Request): Promise<AuthenticatedDevice | undefined> {
    const header = request.headers[DEVICE_TOKEN_HEADER];
    const token = Array.isArray(header) ? header[0] : header;
    if (token === undefined || token === '') return undefined;
    const claims = await this.tokens.verify(token);
    if (claims === undefined) return undefined;
    const device = await this.prisma.device.findFirst({
      where: { id: claims.deviceId, restaurantId: claims.restaurantId, status: 'ACTIVE' },
    });
    if (device === null) return undefined;
    const now = new Date();
    if (
      device.lastSeenAt === null ||
      now.getTime() - device.lastSeenAt.getTime() > SEEN_INTERVAL_MS
    ) {
      await this.prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: now } });
    }
    return {
      deviceId: device.id,
      restaurantId: device.restaurantId,
      type: device.type,
      tableId: device.tableId,
      stationId: device.stationId,
      staffId: device.staffId,
    };
  }
}
