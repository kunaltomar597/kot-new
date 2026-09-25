import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  DEVICE_TOKEN_HEADER,
  DeviceChallengeResponse,
  DeviceTokenResponse,
  deviceTokenMessage,
  LoginResponse,
} from '@rp/contracts';
import { ROLES, type Role } from '@rp/domain';
import request from 'supertest';
import { authSettingKey, AuthSettingsService } from '../../src/auth/auth-settings.js';
import { CredentialHasher } from '../../src/auth/credential-hasher.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { httpServer } from './test-app.js';

export const TEST_PINS: Readonly<Record<Role, string>> = {
  OWNER: '1111',
  MANAGER: '2222',
  CASHIER: '3333',
  WAITER: '4444',
  KITCHEN: '6666',
};

/** Device tokens (and keys) of the devices tests registered, by device id. */
const deviceCredentials = new Map<string, { token: string; privateKey: KeyObject }>();

/** Signs like a device: raw 64-byte signatures (r‖s for ECDSA P-256, as WebCrypto gives), base64. */
export function signAsDevice(privateKey: KeyObject, message: string): string {
  const data = Buffer.from(message, 'utf8');
  const signature =
    privateKey.asymmetricKeyType === 'ec'
      ? sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' })
      : sign(null, data, privateKey);
  return signature.toString('base64');
}

/** Gets a device token for a registered device through the real challenge/token endpoints. */
export async function authenticateDevice(
  app: INestApplication,
  deviceId: string,
  privateKey: KeyObject,
): Promise<string> {
  const { challenge } = DeviceChallengeResponse.parse(
    (await request(httpServer(app)).post('/api/v1/devices/challenge').send({ deviceId })).body,
  );
  const response = await request(httpServer(app))
    .post('/api/v1/devices/token')
    .send({
      deviceId,
      challenge,
      signature: signAsDevice(privateKey, deviceTokenMessage(deviceId, challenge)),
    });
  if (response.status !== 200) {
    throw new Error(
      `Device token failed: ${String(response.status)} ${JSON.stringify(response.body)}`,
    );
  }
  const { deviceToken } = DeviceTokenResponse.parse(response.body);
  deviceCredentials.set(deviceId, { token: deviceToken, privateKey });
  return deviceToken;
}

/**
 * A device as if a manager had paired it (its public key registered), authenticated through the
 * real device-token flow. Pairing itself is tested in devices.int.test.ts.
 */
export type TestDeviceType =
  'POS' | 'WAITER_PHONE' | 'MANAGER_BROWSER' | 'KDS' | 'TABLE_TABLET' | 'PAGER';

/** What a device is bound to: a tablet's table, a kitchen screen's station, a pager's wearer. */
export interface TestDeviceBinding {
  readonly tableId?: string;
  readonly stationId?: string;
  readonly staffId?: string;
}

export async function registerDevice(
  app: INestApplication,
  restaurantId: string,
  type: TestDeviceType = 'POS',
  binding: TestDeviceBinding = {},
): Promise<string> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const device = await app.get(PrismaService).device.create({
    data: {
      restaurantId,
      type,
      name: `Test ${type}`,
      status: 'ACTIVE',
      pairedAt: new Date(),
      publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      keyAlgorithm: 'Ed25519',
      tableId: binding.tableId ?? null,
      stationId: binding.stationId ?? null,
      staffId: binding.staffId ?? null,
    },
  });
  await authenticateDevice(app, device.id, privateKey);
  return device.id;
}

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
  const settings: [string, unknown][] = [
    // Tests move the clock by hours; device tokens should not be the thing that expires.
    [authSettingKey('deviceTokenMinutes'), 24 * 60],
    ...(options.kitchenLogins !== false
      ? [[authSettingKey('kitchenIndividualLogins'), true] as [string, unknown]]
      : []),
  ];
  for (const [key, value] of settings) {
    await prisma.setting.upsert({
      where: { restaurantId_key: { restaurantId, key } },
      create: { restaurantId, key, value: value as number | boolean },
      update: { value: value as number | boolean },
    });
  }
  app.get(AuthSettingsService).invalidate();
  const deviceId = await registerDevice(app, restaurantId);
  return { restaurantId, deviceId, staff: staff as Record<Role, string> };
}

/** Another paired device of the kit's restaurant. */
export function addDevice(
  app: INestApplication,
  kit: AuthKit,
  type: TestDeviceType = 'POS',
  binding: TestDeviceBinding = {},
): Promise<string> {
  return registerDevice(app, kit.restaurantId, type, binding);
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
    .set(authHeaders(deviceId))
    .send({ staffId: kit.staff[role], pin: TEST_PINS[role] });
  if (response.status !== 200) {
    throw new Error(
      `Sign-in as ${role} failed: ${String(response.status)} ${JSON.stringify(response.body)}`,
    );
  }
  return LoginResponse.parse(response.body);
}

/** The device token of a device the kit registered (for socket handshakes). */
export function deviceTokenOf(deviceId: string): string {
  const credentials = deviceCredentials.get(deviceId);
  if (credentials === undefined)
    throw new Error(`Device ${deviceId} was not registered by the kit`);
  return credentials.token;
}

/**
 * Headers of a request from a device (its device token, when the device was registered by the
 * kit) and, optionally, a signed-in person.
 */
export function authHeaders(deviceId: string, accessToken?: string): Record<string, string> {
  const credentials = deviceCredentials.get(deviceId);
  return {
    ...(credentials !== undefined && { [DEVICE_TOKEN_HEADER]: credentials.token }),
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
