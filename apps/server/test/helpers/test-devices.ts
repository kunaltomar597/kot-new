import type { Request } from 'express';
import type { AuthenticatedDevice, DeviceAuthenticator } from '../../src/auth/device.js';
import type { PrismaService } from '../../src/database/prisma.service.js';

/** Header naming the calling device in tests; stands in for device credentials until P0-11. */
export const TEST_DEVICE_HEADER = 'x-test-device';

/** Recognises an ACTIVE device named in the test header. Never used outside tests. */
export class TestDeviceAuthenticator implements DeviceAuthenticator {
  constructor(private readonly prisma: PrismaService) {}

  async authenticate(request: Request): Promise<AuthenticatedDevice | undefined> {
    const id = request.headers[TEST_DEVICE_HEADER];
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const device = await this.prisma.device.findFirst({ where: { id, status: 'ACTIVE' } });
    return device === null
      ? undefined
      : {
          deviceId: device.id,
          restaurantId: device.restaurantId,
          type: device.type,
          tableId: device.tableId,
        };
  }
}
