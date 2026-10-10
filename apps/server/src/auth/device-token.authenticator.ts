import { Injectable } from '@nestjs/common';
import { DEVICE_TOKEN_HEADER } from '@rp/contracts';
import type { Request } from 'express';
import { PrismaService } from '../database/prisma.service.js';
import type { AuthenticatedDevice, DeviceAuthenticator } from './device.js';
import { type DeviceTokenClaims, DeviceTokenService } from './device-token.service.js';

/** The device token header's value; empty when missing. */
function deviceTokenOf(request: Request): string {
  const header = request.headers[DEVICE_TOKEN_HEADER];
  return (Array.isArray(header) ? header[0] : header) ?? '';
}

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
    return this.authenticateToken(deviceTokenOf(request));
  }

  /**
   * The paired device a device token belongs to; also used for socket handshakes (P0-12). Always
   * verified; a missing token simply fails verification (CWE-807). `beforeLookup` sees the
   * token's device once its signature is checked, before the database is asked, and may refuse it
   * by throwing (the socket's limits per device, PC-D3).
   */
  async authenticateToken(
    token: string,
    beforeLookup?: (claims: DeviceTokenClaims) => void,
  ): Promise<AuthenticatedDevice | undefined> {
    const claims = await this.tokens.verify(token);
    if (claims === undefined) return undefined;
    beforeLookup?.(claims);
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
      stationIds: device.stationId === null ? [] : [device.stationId, ...device.extraStationIds],
      staffId: device.staffId,
    };
  }
}
