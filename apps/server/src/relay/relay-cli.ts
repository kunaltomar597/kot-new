import 'reflect-metadata';
import { pathToFileURL } from 'node:url';
import { AuditService } from '../audit/audit.service.js';
import { createSecretStore } from '../auth/secret-store.js';
import { loadConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { saveRelayCredential } from './relay-credential.js';

/** Reads everything piped in, so the credential never appears in the shell's history. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `node dist/relay/relay-cli.js credential < file`: stores the QR relay credential the vendor
 * issued for this restaurant (VCP-002, ADR-0015), sealed in the database. Support runs it until
 * the Control Plane delivers credentials itself (P7).
 */
async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] !== 'credential') {
    process.stderr.write('Usage: node dist/relay/relay-cli.js credential < credential.txt\n');
    return 1;
  }
  const credential = (await readStdin()).trim();
  const config = loadConfig();
  const prisma = new PrismaService(config);
  try {
    await prisma.transaction(async (tx) => {
      await saveRelayCredential(tx, createSecretStore(config), credential);
      // AUD-001, without the credential itself; before the setup wizard there is no restaurant.
      if ((await tx.restaurant.count()) > 0) {
        await new AuditService(prisma).record(tx, {
          action: 'RELAY_CREDENTIAL_SET',
          entityType: 'relay',
          entityId: 'credential',
          after: { relayUrl: config.relayUrl ?? null },
          reason: 'QR relay credential stored from the command line',
        });
      }
    });
    process.stdout.write(
      config.relayUrl === undefined
        ? 'Stored. Set RP_RELAY_URL so the server can reach the relay.\n'
        : 'Stored. The server uses it within a minute.\n',
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
