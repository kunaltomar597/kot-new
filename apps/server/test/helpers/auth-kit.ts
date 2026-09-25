import type { INestApplication } from '@nestjs/common';
import { LoginResponse } from '@rp/contracts';
import { ROLES, type Role } from '@rp/domain';
import request from 'supertest';
import { authSettingKey, AuthSettingsService } from '../../src/auth/auth-settings.js';
import { CredentialHasher } from '../../src/auth/credential-hasher.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { httpServer } from './test-app.js';
import { TEST_DEVICE_HEADER } from './test-devices.js';

export const TEST_PINS: Readonly<Record<Role, string>> = {
  OWNER: '1111',
  MANAGER: '2222',
  CASHIER: '3333',
  WAITER: '4444',
  KITCHEN: '6666',
};

export interface AuthKit {
  readonly restaurantId: string;
  /** A paired POS terminal. */
  readonly deviceId: string;
  /** One person per role, each with the PIN in TEST_PINS. */
  readonly staff: Readonly<Record<Role, string>>;
}

/**
 * A restaurant with one person of every role (PINs in TEST_PINS) and a paired POS device, created
 * through the application's own services. Kitchen staff may sign in individually unless
 * `kitchenLogins` is false.
 */
export async function createAuthKit(
  app: INestApplication,
  options: { kitchenLogins?: boolean; restaurantId?: string } = {},
): Promise<AuthKit> {
  const prisma = app.get(PrismaService);
  const hasher = app.get(CredentialHasher);
  const restaurantId =
    options.restaurantId ??
    (await prisma.restaurant.create({ data: { displayName: 'Auth Dhaba' } })).id;
  const staff: Partial<Record<Role, string>> = {};
  for (const role of ROLES) {
    const roleRow = await prisma.role.upsert({
      where: { restaurantId_key: { restaurantId, key: role } },
      create: { restaurantId, key: role, name: role, baseRole: role },
      update: {},
    });
    const person = await prisma.staff.create({
      data: { restaurantId, roleId: roleRow.id, displayName: `Test ${role.toLowerCase()}` },
    });
    await prisma.credential.create({
      data: {
        restaurantId,
        staffId: person.id,
        kind: 'PIN',
        secretHash: await hasher.hash(TEST_PINS[role]),
      },
    });
    staff[role] = person.id;
  }
  if (options.kitchenLogins !== false) {
    await prisma.setting.upsert({
      where: {
        restaurantId_key: { restaurantId, key: authSettingKey('kitchenIndividualLogins') },
      },
      create: { restaurantId, key: authSettingKey('kitchenIndividualLogins'), value: true },
      update: { value: true },
    });
    app.get(AuthSettingsService).invalidate();
  }
  const device = await prisma.device.create({
    data: { restaurantId, type: 'POS', name: 'Test POS', status: 'ACTIVE', pairedAt: new Date() },
  });
  return { restaurantId, deviceId: device.id, staff: staff as Record<Role, string> };
}

/** A second paired device of the kit's restaurant. */
export async function addDevice(
  app: INestApplication,
  kit: AuthKit,
  type: 'POS' | 'WAITER_PHONE' | 'MANAGER_BROWSER' | 'KDS' = 'POS',
): Promise<string> {
  const device = await app.get(PrismaService).device.create({
    data: { restaurantId: kit.restaurantId, type, name: `Test ${type}`, status: 'ACTIVE' },
  });
  return device.id;
}

/** Signs in with the role's PIN on the kit's device (or another one) and returns the tokens. */
export async function signIn(
  app: INestApplication,
  kit: AuthKit,
  role: Role,
  deviceId: string = kit.deviceId,
): Promise<LoginResponse> {
  const response = await request(httpServer(app))
    .post('/api/v1/auth/pin-login')
    .set(TEST_DEVICE_HEADER, deviceId)
    .send({ staffId: kit.staff[role], pin: TEST_PINS[role] });
  if (response.status !== 200) {
    throw new Error(
      `Sign-in as ${role} failed: ${String(response.status)} ${JSON.stringify(response.body)}`,
    );
  }
  return LoginResponse.parse(response.body);
}

/** Headers of an authenticated request from a device. */
export function authHeaders(deviceId: string, accessToken?: string): Record<string, string> {
  return {
    [TEST_DEVICE_HEADER]: deviceId,
    ...(accessToken !== undefined && { authorization: `Bearer ${accessToken}` }),
  };
}

/** Another person of `role` in the kit's restaurant, with the given PIN. */
export async function addStaff(
  app: INestApplication,
  kit: AuthKit,
  role: Role,
  pin: string = TEST_PINS[role],
): Promise<string> {
  const prisma = app.get(PrismaService);
  const roleRow = await prisma.role.findFirstOrThrow({
    where: { restaurantId: kit.restaurantId, key: role },
  });
  const person = await prisma.staff.create({
    data: {
      restaurantId: kit.restaurantId,
      roleId: roleRow.id,
      displayName: `Extra ${role.toLowerCase()}`,
    },
  });
  await prisma.credential.create({
    data: {
      restaurantId: kit.restaurantId,
      staffId: person.id,
      kind: 'PIN',
      secretHash: await app.get(CredentialHasher).hash(pin),
    },
  });
  return person.id;
}
