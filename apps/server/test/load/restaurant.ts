import { createPrivateKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { PagerCredentialResponse } from '@rp/contracts';
import { addDays, type Role } from '@rp/domain';
import pg from 'pg';
import { CredentialHasher } from '../../src/auth/credential-hasher.js';
import { DeviceTokenService } from '../../src/auth/device-token.service.js';
import { currentBusinessDate, dbDate } from '../../src/common/business-dates.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { LearnedAssociations } from '../../src/recommendations/learned-associations.service.js';
import {
  authHeaders,
  createAuthKit,
  signIn,
  TEST_PINS,
  type TestDeviceType,
} from '../helpers/auth-kit.js';
import { api } from '../helpers/test-app.js';
import { generateYear } from '../performance/generate-year.js';
import type { DeviceIdentity, SimulatedKind } from './device.js';
import { type LoadShape, pagerCount, spareScreenCount } from './plan.js';

/** A person who signs in with a PIN. */
export interface LoadPerson {
  readonly staffId: string;
  readonly name: string;
  readonly pin: string;
}

export interface LoadTable {
  readonly id: string;
  readonly sectionId: string;
  /** "T1" to "T100", as the generated history names them. */
  readonly label: string;
  /** The waiter who looks after it today (an index into `people.waiters`). */
  readonly waiter: number;
  /** The tablet on it, if any (an index into the TABLET devices). */
  readonly tablet: number | null;
}

export interface LoadStation {
  readonly id: string;
  readonly printerId: string;
}

export interface LoadPager {
  readonly credential: PagerCredentialResponse;
  readonly wearerId: string;
}

/** The restaurant the load run serves, and everything the simulated devices need. */
export interface LoadRestaurant {
  readonly restaurantId: string;
  readonly businessDate: string;
  readonly tables: readonly LoadTable[];
  readonly stations: readonly LoadStation[];
  readonly billPrinterIds: readonly string[];
  readonly people: {
    readonly waiters: readonly LoadPerson[];
    readonly runners: readonly LoadPerson[];
    readonly managers: readonly LoadPerson[];
    readonly cashiers: readonly LoadPerson[];
  };
  readonly devices: readonly DeviceIdentity[];
  readonly pagers: readonly LoadPager[];
  /** Rows written by the generated history, by table. */
  readonly history: Record<string, number>;
}

/** Where each printer of the run listens (simulated printers on this machine). */
export interface PrinterPorts {
  readonly stations: readonly number[];
  readonly bills: readonly number[];
}

const DEVICE_TYPE: Readonly<Record<SimulatedKind, TestDeviceType>> = {
  TABLET: 'TABLE_TABLET',
  WAITER_PHONE: 'WAITER_PHONE',
  KDS: 'KDS',
  POS: 'POS',
  DASHBOARD: 'MANAGER_BROWSER',
  SPARE_SCREEN: 'MANAGER_BROWSER',
};

/** How many operational days the daily retention keeps (`retention.operationalDays`). */
const OPERATIONAL_DAYS = 90;

/**
 * Sets up the restaurant of the load run (P8-01a) in `app`'s database: §7.2's menu, floor,
 * stations and printers, the people on shift with today's tables, the paired devices and the
 * pagers. With `historyDays`, the year before today is generated as the reports test does
 * (P4-05c), then brought to the state a restaurant that has run for a year is in: the daily
 * retention has left 90 days of alerts, today's suggestions are learned, and the tables are
 * vacuumed and analysed. The devices' keys are made here; the server learns only their public
 * halves, as at pairing. `readyForToday` then sets up the day the run serves.
 */
export async function setUpLoadRestaurant(
  app: INestApplication,
  shape: LoadShape,
  printers: PrinterPorts,
  databaseUrl: string,
  log: (line: string) => void = () => undefined,
): Promise<LoadRestaurant> {
  const prisma = app.get(PrismaService);
  const hasher = app.get(CredentialHasher);
  const kit = await createAuthKit(app, { kitchenLogins: false });
  const restaurantId = kit.restaurantId;
  const base = { restaurantId };
  const businessDate = await currentBusinessDate(prisma, restaurantId);

  // ------------------------------------------------------------ people
  const roles = new Map(
    (await prisma.role.findMany({ where: base })).map((role) => [role.key, role.id]),
  );
  const person = async (role: Role, name: string): Promise<LoadPerson> => {
    const staff = await prisma.staff.create({
      data: { ...base, roleId: roles.get(role) ?? '', displayName: name },
    });
    await prisma.credential.create({
      data: {
        ...base,
        staffId: staff.id,
        kind: 'PIN',
        secretHash: await hasher.hash(TEST_PINS[role]),
      },
    });
    return { staffId: staff.id, name, pin: TEST_PINS[role] };
  };
  const many = async (count: number, role: Role, name: string) => {
    const people: LoadPerson[] = [];
    for (let index = 1; index <= count; index += 1) {
      people.push(await person(role, `${name} ${String(index)}`));
    }
    return people;
  };
  const people = {
    waiters: await many(shape.waiters, 'WAITER', 'Waiter'),
    runners: await many(shape.runners, 'WAITER', 'Runner'),
    managers: await many(shape.managers, 'MANAGER', 'Manager'),
    cashiers: await many(shape.posTerminals, 'CASHIER', 'Cashier'),
  };

  // ------------------------------------------------------------ tax, invoices, kitchen
  const tax = await prisma.taxGroup.create({
    data: {
      ...base,
      name: 'GST 5 %',
      sacCode: '996331',
      components: {
        create: [
          { ...base, code: 'CGST', rateBp: 250 },
          { ...base, code: 'SGST', rateBp: 250 },
        ],
      },
    },
  });
  await prisma.invoiceSeries.create({
    data: { ...base, name: 'Dine-in', prefix: 'INV', isDefault: true },
  });
  // The generated year has its own series, so today's numbers start where a fresh day would.
  const historySeries = await prisma.invoiceSeries.create({
    data: { ...base, name: 'History', prefix: 'OLD' },
  });
  const stations: LoadStation[] = [];
  for (const [index, port] of printers.stations.entries()) {
    const printer = await prisma.printer.create({
      data: {
        ...base,
        name: `Station printer ${String(index + 1)}`,
        connection: 'NETWORK',
        host: '127.0.0.1',
        port,
      },
    });
    const station = await prisma.station.create({
      data: { ...base, name: `Station ${String(index + 1)}`, mode: 'BOTH', printerId: printer.id },
    });
    stations.push({ id: station.id, printerId: printer.id });
  }
  const billPrinterIds: string[] = [];
  for (const [index, port] of printers.bills.entries()) {
    const printer = await prisma.printer.create({
      data: {
        ...base,
        name: `Bill printer ${String(index + 1)}`,
        connection: 'NETWORK',
        host: '127.0.0.1',
        port,
      },
    });
    billPrinterIds.push(printer.id);
  }

  // ------------------------------------------------------------ the menu
  const categories = await Promise.all(
    Array.from({ length: shape.categories }, (_, index) =>
      prisma.category.create({
        data: { ...base, name: `Category ${String(index + 1)}`, displayOrder: index },
      }),
    ),
  );
  const spice = await prisma.modifierGroup.create({
    data: {
      ...base,
      name: 'Spice level',
      minSelections: 0,
      maxSelections: 1,
      options: {
        create: ['Mild', 'Medium', 'Hot'].map((name, order) => ({
          ...base,
          name,
          displayOrder: order,
        })),
      },
    },
  });
  const addOns = await prisma.modifierGroup.create({
    data: {
      ...base,
      name: 'Add-ons',
      minSelections: 0,
      maxSelections: 2,
      options: {
        create: [
          ['Extra butter', 2_000],
          ['Extra cheese', 4_000],
          ['No onion', 0],
        ].map(([name, priceDelta], order) => ({
          ...base,
          name: String(name),
          priceDelta: Number(priceDelta),
          displayOrder: order,
        })),
      },
    },
  });
  // Dish 0 to Dish 999, the names the generated history orders; each station cooks its share.
  const dishes = Array.from({ length: shape.dishes }, (_, index) => ({
    ...base,
    id: randomUUID(),
    categoryId: categories[index % categories.length]?.id ?? '',
    name: `Dish ${String(index)}`,
    basePrice: 8_000 + (index % 33) * 1_000,
    taxGroupId: tax.id,
    foodType: index % 3 === 0 ? ('NON_VEG' as const) : ('VEG' as const),
    stationId: stations[index % stations.length]?.id ?? '',
    displayOrder: index,
  }));
  await prisma.item.createMany({ data: dishes });
  await prisma.variant.createMany({
    data: dishes
      .filter((_, index) => index % 10 === 0)
      .flatMap((dish) => [
        { ...base, itemId: dish.id, name: 'Half', price: dish.basePrice, displayOrder: 0 },
        { ...base, itemId: dish.id, name: 'Full', price: dish.basePrice * 2, displayOrder: 1 },
      ]),
  });
  await prisma.itemModifierGroup.createMany({
    data: dishes.flatMap((dish, index) => [
      ...(index % 5 === 0
        ? [{ ...base, itemId: dish.id, groupId: spice.id, displayOrder: 0 }]
        : []),
      ...(index % 7 === 0
        ? [{ ...base, itemId: dish.id, groupId: addOns.id, displayOrder: 1 }]
        : []),
    ]),
  });
  const manager = await signIn(app, kit, 'MANAGER');
  const published = await api(app)
    .post('/api/v1/menu/publish')
    .set(authHeaders(kit.deviceId, manager.accessToken));
  if (published.status !== 200) {
    throw new Error(`Publishing the menu failed: ${JSON.stringify(published.body)}`);
  }

  // ------------------------------------------------------------ the floor and today's tables
  const sections = await Promise.all(
    Array.from({ length: shape.sections }, (_, index) =>
      prisma.section.create({
        data: { ...base, name: `Section ${String(index + 1)}`, displayOrder: index },
      }),
    ),
  );
  const tables: LoadTable[] = [];
  for (let index = 0; index < shape.tables; index += 1) {
    const section = sections[Math.floor((index * sections.length) / shape.tables)];
    if (section === undefined) throw new Error('No section');
    const table = await prisma.diningTable.create({
      data: {
        ...base,
        sectionId: section.id,
        label: `T${String(index + 1)}`,
        capacity: 4,
        displayOrder: index,
      },
    });
    const waiter = index % shape.waiters;
    tables.push({
      id: table.id,
      sectionId: section.id,
      label: table.label,
      waiter,
      tablet: index < shape.tablets ? index : null,
    });
  }

  // ------------------------------------------------------------ devices, paired
  const devices: DeviceIdentity[] = [];
  const pair = async (
    kind: SimulatedKind,
    binding: { tableId?: string; stationId?: string; staffId?: string },
    signedIn?: LoadPerson,
  ): Promise<void> => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const device = await prisma.device.create({
      data: {
        ...base,
        type: DEVICE_TYPE[kind],
        name: `${kind} ${String(devices.length + 1)}`,
        status: 'ACTIVE',
        pairedAt: new Date(),
        publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        keyAlgorithm: 'Ed25519',
        tableId: binding.tableId ?? null,
        stationId: binding.stationId ?? null,
        staffId: binding.staffId ?? null,
      },
    });
    devices.push({
      kind,
      deviceId: device.id,
      privateKey,
      ...(signedIn !== undefined && { person: { staffId: signedIn.staffId, pin: signedIn.pin } }),
    });
  };
  for (const table of tables)
    if (table.tablet !== null) await pair('TABLET', { tableId: table.id });
  for (const waiter of people.waiters) {
    await pair('WAITER_PHONE', { staffId: waiter.staffId }, waiter);
  }
  for (const station of stations) await pair('KDS', { stationId: station.id });
  for (const cashier of people.cashiers) await pair('POS', {}, cashier);
  const managerAt = (index: number): LoadPerson => {
    const found = people.managers[index % people.managers.length];
    if (found === undefined) throw new Error('No manager');
    return found;
  };
  for (let index = 0; index < shape.dashboards; index += 1) {
    await pair('DASHBOARD', {}, managerAt(index));
  }
  for (let index = 0; index < spareScreenCount(shape); index += 1) {
    await pair('SPARE_SCREEN', {}, managerAt(index));
  }

  // ------------------------------------------------------------ pagers
  const wearers = [...people.waiters, ...people.runners, ...people.managers];
  if (wearers.length !== pagerCount(shape)) throw new Error('One pager per wearer');
  const pagers: LoadPager[] = [];
  for (const [index, wearer] of wearers.entries()) {
    const response = await api(app)
      .post('/api/v1/pagers')
      .set(authHeaders(kit.deviceId, manager.accessToken))
      .send({
        serial: `LOAD-${String(index + 1)}`,
        name: `Pager ${String(index + 1)}`,
        staffId: wearer.staffId,
      });
    if (response.status !== 201) {
      throw new Error(`Registering a pager failed: ${JSON.stringify(response.body)}`);
    }
    pagers.push({
      credential: PagerCredentialResponse.parse(response.body),
      wearerId: wearer.staffId,
    });
  }

  // ------------------------------------------------------------ a year of history
  let history: Record<string, number> = {};
  if (shape.historyDays > 0) {
    log(
      `Generating ${String(shape.historyDays)} days at ${String(shape.historyOrdersPerDay)} orders a day`,
    );
    const generated = await generateYear(
      prisma,
      {
        restaurantId,
        deviceId: kit.deviceId,
        waiterId: people.waiters[0]?.staffId ?? kit.staff.WAITER,
        cashierId: people.cashiers[0]?.staffId ?? kit.staff.CASHIER,
        managerId: managerAt(0).staffId,
        taxGroupId: tax.id,
        stationId: stations[0]?.id ?? '',
        seriesId: historySeries.id,
      },
      {
        lastDay: addDays(businessDate, -1),
        days: shape.historyDays,
        ordersPerDay: shape.historyOrdersPerDay,
      },
    );
    history = generated.rows;
    await steadyState(databaseUrl, restaurantId, addDays(businessDate, -OPERATIONAL_DAYS));
  }
  return {
    restaurantId,
    businessDate,
    tables,
    stations,
    billPrinterIds,
    people,
    devices,
    pagers,
    history,
  };
}

/**
 * The day the run serves, on a restaurant set up today or before (P8-01a): the printers where the
 * simulated ones listen now, today's tables given to the waiters one by one (TBL-002, so "my
 * tables" is theirs alone), today's suggestions learned as on a PC that was on at the 04:00
 * cut-off (P6-02), and each device's token. The devices start with the token they fetched before
 * the rush: 200 challenges from this one address would trip the limit per address (60 a minute),
 * which each device of a restaurant has to itself.
 */
export async function readyForToday(
  app: INestApplication,
  restaurant: LoadRestaurant,
  printers: PrinterPorts,
): Promise<LoadRestaurant> {
  const prisma = app.get(PrismaService);
  const { restaurantId } = restaurant;
  const businessDate = await currentBusinessDate(prisma, restaurantId);
  const ports: [string, number | undefined][] = [
    ...restaurant.stations.map((station, index): [string, number | undefined] => [
      station.printerId,
      printers.stations[index],
    ]),
    ...restaurant.billPrinterIds.map((id, index): [string, number | undefined] => [
      id,
      printers.bills[index],
    ]),
  ];
  for (const [id, port] of ports) {
    if (port === undefined) throw new Error('A printer of the restaurant has no simulated printer');
    await prisma.printer.update({
      where: { id },
      data: { port, offlineSince: null, lastError: null },
    });
  }
  const assigned = await prisma.shiftAssignment.count({
    where: { restaurantId, businessDate: dbDate(businessDate) },
  });
  if (assigned === 0) {
    await prisma.shiftAssignment.createMany({
      data: restaurant.tables.map((table) => ({
        restaurantId,
        staffId: restaurant.people.waiters[table.waiter]?.staffId ?? '',
        sectionId: table.sectionId,
        tableId: table.id,
        businessDate: dbDate(businessDate),
      })),
    });
  }
  await app.get(LearnedAssociations).learn(restaurantId);
  const tokens = app.get(DeviceTokenService);
  const devices: DeviceIdentity[] = [];
  for (const device of restaurant.devices) {
    const token = await tokens.sign({ deviceId: device.deviceId, restaurantId }, 24 * 3_600);
    devices.push({
      ...device,
      token: { value: token.token, expiresAt: token.expiresAt.toISOString() },
    });
  }
  return { ...restaurant, businessDate, devices };
}

/** Keeps a set-up restaurant for later runs (`RP_LOAD_BASE`), its devices' keys included. */
export function saveRestaurant(path: string, restaurant: LoadRestaurant): void {
  writeFileSync(
    path,
    JSON.stringify({
      ...restaurant,
      devices: restaurant.devices.map(({ token: _token, ...device }) => ({
        ...device,
        privateKey: device.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      })),
    }),
  );
}

export function loadRestaurant(path: string): LoadRestaurant {
  const saved = JSON.parse(readFileSync(path, 'utf8')) as Omit<LoadRestaurant, 'devices'> & {
    devices: (Omit<DeviceIdentity, 'privateKey'> & { privateKey: string })[];
  };
  return {
    ...saved,
    devices: saved.devices.map((device) => ({
      ...device,
      privateKey: createPrivateKey(device.privateKey),
    })),
  };
}

/**
 * What a year of daily retention (P7-06a) and autovacuum leave: alerts and service requests of
 * the last 90 days only, and fresh statistics. The generator writes every row with today's
 * `updated_at`, so the retention itself would keep them all.
 */
async function steadyState(
  databaseUrl: string,
  restaurantId: string,
  before: string,
): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `DELETE FROM service_requests WHERE restaurant_id = $1 AND business_date < $2`,
      [restaurantId, before],
    );
    await client.query(
      `DELETE FROM alerts a WHERE a.restaurant_id = $1 AND a.business_date < $2
         AND NOT EXISTS (SELECT 1 FROM service_requests s WHERE s.alert_id = a.id)`,
      [restaurantId, before],
    );
    await client.query('VACUUM ANALYZE');
  } finally {
    await client.end();
  }
}
