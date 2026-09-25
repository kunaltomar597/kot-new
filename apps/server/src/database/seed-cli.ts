// Development seed entry point: `pnpm --filter @rp/server db:seed` (after `build`).
// Reads DATABASE_URL (and RP_DATA_DIR for the secrets the server uses to check PINs); refuses to
// run on a database that already holds a restaurant.
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { CredentialHasher } from '../auth/credential-hasher.js';
import { FileSecretStore } from '../auth/secret-store.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { seedDevelopmentData } from './dev-seed.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  process.stderr.write('Set DATABASE_URL to the development database.\n');
  process.exit(1);
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
try {
  const hasher = new CredentialHasher(
    new FileSecretStore(join(process.env.RP_DATA_DIR ?? './.data', 'secrets')),
  );
  const summary = await seedDevelopmentData(prisma, { hashPin: (pin) => hasher.hash(pin) });
  process.stdout.write(`Seeded ${JSON.stringify(summary)}\n`);
} finally {
  await prisma.$disconnect();
}
