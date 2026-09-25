// Development seed entry point: `pnpm --filter @rp/server db:seed` (after `build`).
// Reads DATABASE_URL; refuses to run on a database that already holds a restaurant.
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { seedDevelopmentData } from './dev-seed.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  process.stderr.write('Set DATABASE_URL to the development database.\n');
  process.exit(1);
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
try {
  const summary = await seedDevelopmentData(prisma);
  process.stdout.write(`Seeded ${JSON.stringify(summary)}\n`);
} finally {
  await prisma.$disconnect();
}
