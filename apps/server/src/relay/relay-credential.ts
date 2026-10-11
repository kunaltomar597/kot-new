import { RelayCredential } from '@rp/contracts/relay';
import type { SecretStore } from '../auth/secret-store.js';
import { open, seal } from '../auth/secret-box.js';
import type { PrismaService, TransactionClient } from '../database/prisma.service.js';

type Client = PrismaService | TransactionClient;

const CREDENTIAL_KEY = 'relay.credential';

/**
 * The QR relay credential the Control Plane issues for this restaurant (VCP-002, ADR-0015): kept
 * in the database sealed with a key from the SecretStore, never in the configuration or a log.
 */
export async function readRelayCredential(
  prisma: Client,
  secrets: SecretStore,
): Promise<string | undefined> {
  const row = await prisma.systemMeta.findUnique({ where: { key: CREDENTIAL_KEY } });
  if (row === null) return undefined;
  const credential = open(await secrets.get('relay-credential-key'), row.value).toString('utf8');
  return RelayCredential.safeParse(credential).success ? credential : undefined;
}

/** Stores (or replaces) the credential; refuses anything that is not one. */
export async function saveRelayCredential(
  prisma: Client,
  secrets: SecretStore,
  credential: string,
): Promise<void> {
  const parsed = RelayCredential.safeParse(credential.trim());
  if (!parsed.success) throw new Error('That is not a relay credential.');
  const value = seal(await secrets.get('relay-credential-key'), Buffer.from(parsed.data, 'utf8'));
  await prisma.systemMeta.upsert({
    where: { key: CREDENTIAL_KEY },
    create: { key: CREDENTIAL_KEY, value },
    update: { value },
  });
}
