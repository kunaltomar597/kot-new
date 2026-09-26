import 'reflect-metadata';
import { pathToFileURL } from 'node:url';
import { createSecretStore } from '../auth/secret-store.js';
import { loadConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { enrolInstallation } from './enrolment.js';

/**
 * `node dist/cloud/enrol-cli.js <enrolment code>`: enrols this PC with the Vendor Control Plane
 * (ADR-0012). Needs RP_CONTROL_PLANE_URL and the server's usual configuration. The installer runs
 * it during activation (P0-16); support can run it by hand.
 */
async function main(argv: readonly string[]): Promise<number> {
  const code = argv.join(' ').trim();
  if (code === '') {
    process.stderr.write('Usage: node dist/cloud/enrol-cli.js <enrolment code from the vendor>\n');
    return 1;
  }
  const config = loadConfig();
  const prisma = new PrismaService(config);
  try {
    const enrolment = await enrolInstallation({
      config,
      prisma,
      secrets: createSecretStore(config),
      code,
    });
    process.stdout.write(
      `Enrolled as installation ${enrolment.installationId} (${enrolment.name}, ${enrolment.channel} channel).\n`,
    );
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
