import { Inject, Injectable } from '@nestjs/common';
import type { RelayProvisioningView, SupportNoteView } from '@rp/contracts/control-plane';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { CP_CONFIG, type CpConfig } from '../config/cp-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { CpError } from '../errors/cp-error.js';
import type { RelayProvisioning } from '../generated/prisma/client.js';
import { newId } from '../ids.js';
import { open, seal, secretKeyOf } from '../vendor/secret-key.js';
import { RELAY_PROVISIONER, type RelayProvisioner } from './relay-provisioner.js';

/** The first 16 hex digits of a credential's SHA-256: what the PC reports holding. */
export function relayDigest(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('hex').slice(0, 16);
}

function provisioningView(row: RelayProvisioning): RelayProvisioningView {
  return {
    tenantId: row.tenantId,
    provisionedAt: row.provisionedAt.toISOString(),
    credentialIssuedAt: row.credentialIssuedAt.toISOString(),
    delivered: row.deliveredAt !== null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
  };
}

function tenantNotFound(): CpError {
  return new CpError(404, 'NOT_FOUND', 'The tenant was not found.');
}

/**
 * Support tools (VCP-007, VCP-008, P7-02d): notes about a restaurant, and its provisioning in the
 * QR relay with a scoped credential that reaches its PC in heartbeat answers until the PC holds
 * it. No business data: the relay holds only what the QR menu needs (ADR-0015).
 */
@Injectable()
export class SupportService {
  private readonly key: Buffer;

  constructor(
    @Inject(CP_CONFIG) config: CpConfig,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(RELAY_PROVISIONER) private readonly relay: RelayProvisioner,
  ) {
    this.key = secretKeyOf(config);
  }

  async notes(tenantId: string): Promise<SupportNoteView[]> {
    await this.tenant(tenantId);
    const notes = await this.prisma.supportNote.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
    const names = await this.authorNames(notes.map((note) => note.author));
    return notes.map((note) => ({
      id: note.id,
      tenantId: note.tenantId,
      author: note.author,
      authorName: names.get(note.author) ?? null,
      body: note.body,
      createdAt: note.createdAt.toISOString(),
    }));
  }

  async addNote(tenantId: string, body: string, actor: string): Promise<SupportNoteView> {
    await this.tenant(tenantId);
    const note = await this.prisma.transaction(async (tx) => {
      const created = await tx.supportNote.create({
        data: { id: newId(), tenantId, author: actor, body },
      });
      await this.audit.record(tx, {
        actor,
        action: 'support.note_added',
        targetType: 'tenant',
        targetId: tenantId,
        details: { noteId: created.id },
      });
      return created;
    });
    const names = await this.authorNames([actor]);
    return {
      id: note.id,
      tenantId,
      author: actor,
      authorName: names.get(actor) ?? null,
      body: note.body,
      createdAt: note.createdAt.toISOString(),
    };
  }

  async relayProvisioning(tenantId: string): Promise<RelayProvisioningView> {
    await this.tenant(tenantId);
    const row = await this.prisma.relayProvisioning.findUnique({ where: { tenantId } });
    if (row === null) throw new CpError(404, 'NOT_FOUND', 'Not provisioned in the QR relay yet.');
    return provisioningView(row);
  }

  /**
   * Provisions the restaurant in the QR relay with a new credential (VCP-002); a rotation revokes
   * the old one at once. The credential is kept sealed until its PC reports holding it.
   */
  async provisionRelay(tenantId: string, actor: string): Promise<RelayProvisioningView> {
    if (!this.relay.configured) {
      throw new CpError(409, 'RELAY_NOT_CONFIGURED', 'The QR relay is not configured here.');
    }
    const tenant = await this.tenant(tenantId);
    const credential = randomBytes(32).toString('base64url');
    const credentialId = await this.relay.provision(
      tenantId,
      tenant.name,
      createHash('sha256').update(credential, 'utf8').digest(),
      'Restaurant PC',
    );
    const now = new Date();
    const previous = await this.prisma.relayProvisioning.findUnique({ where: { tenantId } });
    const row = await this.prisma.transaction(async (tx) => {
      const saved = await tx.relayProvisioning.upsert({
        where: { tenantId },
        create: {
          tenantId,
          credentialId,
          credentialSealed: seal(this.key, Buffer.from(credential, 'utf8')),
          credentialDigest: relayDigest(credential),
          provisionedAt: now,
          credentialIssuedAt: now,
        },
        update: {
          credentialId,
          credentialSealed: seal(this.key, Buffer.from(credential, 'utf8')),
          credentialDigest: relayDigest(credential),
          credentialIssuedAt: now,
          deliveredAt: null,
        },
      });
      await this.audit.record(tx, {
        actor,
        action: previous === null ? 'relay.provisioned' : 'relay.credential_rotated',
        targetType: 'tenant',
        targetId: tenantId,
        details: { credentialId },
      });
      return saved;
    });
    if (previous !== null) await this.relay.revoke(previous.credentialId);
    return provisioningView(row);
  }

  /**
   * The relay credential for a heartbeat answer: while the PC reports holding another (or none),
   * it is sent; once it reports this one, delivery is recorded.
   */
  async relayCredentialFor(
    tenantId: string,
    reportedDigest: string | null | undefined,
  ): Promise<string | null> {
    const row = await this.prisma.relayProvisioning.findUnique({ where: { tenantId } });
    if (row === null || reportedDigest === undefined) return null;
    if (reportedDigest === row.credentialDigest) {
      if (row.deliveredAt === null) {
        await this.prisma.relayProvisioning.update({
          where: { tenantId },
          data: { deliveredAt: new Date() },
        });
      }
      return null;
    }
    return open(this.key, row.credentialSealed).toString('utf8');
  }

  private async tenant(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (tenant === null) throw tenantNotFound();
    return tenant;
  }

  private async authorNames(authors: readonly string[]): Promise<Map<string, string>> {
    const ids = authors.flatMap((author) =>
      author.startsWith('vendor:') ? [author.slice('vendor:'.length)] : [],
    );
    if (ids.length === 0) return new Map();
    const users = await this.prisma.vendorUser.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, name: true },
    });
    return new Map(users.map((user) => [`vendor:${user.id}`, user.name]));
  }
}
