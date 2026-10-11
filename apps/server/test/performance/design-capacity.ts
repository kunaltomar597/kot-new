import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service.js';
import type { AuthKit } from '../helpers/auth-kit.js';
import { generateYear, type YearRefs, type YearShape } from './generate-year.js';

/**
 * The kit's restaurant at the BRD's design capacity (§7.2): 1,000 dishes in 20 categories, 100
 * tables, a kitchen station, GST 5 % and an invoice series. Returns what `generateYear` needs.
 */
export async function seedDesignRestaurant(app: INestApplication, kit: AuthKit): Promise<YearRefs> {
  const prisma = app.get(PrismaService);
  const base = { restaurantId: kit.restaurantId };
  const station = await prisma.station.create({
    data: { ...base, name: 'Kitchen', mode: 'SCREEN' },
  });
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
  const categories = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      prisma.category.create({ data: { ...base, name: `Category ${String(index)}` } }),
    ),
  );
  await prisma.item.createMany({
    data: Array.from({ length: 1_000 }, (_, index) => ({
      ...base,
      categoryId: categories[index % categories.length]?.id ?? '',
      name: `Dish ${String(index)}`,
      basePrice: 10_000 + (index % 30) * 1_000,
      taxGroupId: tax.id,
      foodType: 'VEG' as const,
      stationId: station.id,
    })),
  });
  const section = await prisma.section.create({ data: { ...base, name: 'Hall' } });
  await prisma.diningTable.createMany({
    data: Array.from({ length: 100 }, (_, index) => ({
      ...base,
      sectionId: section.id,
      label: `T${String(index + 1)}`,
    })),
  });
  const series = await prisma.invoiceSeries.create({
    data: { ...base, name: 'Main', prefix: 'INV', isDefault: true },
  });
  return {
    restaurantId: kit.restaurantId,
    deviceId: kit.deviceId,
    waiterId: kit.staff.WAITER,
    cashierId: kit.staff.CASHIER,
    managerId: kit.staff.MANAGER,
    taxGroupId: tax.id,
    stationId: station.id,
    seriesId: series.id,
  };
}

/**
 * The design-capacity restaurant with `generateYear`'s orders. Shared by the performance runs
 * (reports P4-05c, restore P7-05b, volume P7-06d) and the archive tests.
 */
export async function seedDesignCapacity(
  app: INestApplication,
  kit: AuthKit,
  shape: YearShape,
): Promise<{ readonly firstDay: string; readonly rows: Record<string, number> }> {
  return generateYear(app.get(PrismaService), await seedDesignRestaurant(app, kit), shape);
}
