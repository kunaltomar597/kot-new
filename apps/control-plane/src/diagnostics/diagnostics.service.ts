import { Injectable } from '@nestjs/common';
import {
  DIAGNOSTICS_MAX_BYTES,
  DiagnosticsBundle,
  DiagnosticsUploadRequest,
  type DiagnosticsUploadResponse,
  type VendorDiagnosticsDetail,
  type VendorDiagnosticsView,
} from '@rp/contracts/control-plane';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { CpError } from '../errors/cp-error.js';
import type { DiagnosticsBundle as BundleRow, Prisma } from '../generated/prisma/client.js';
import { newId } from '../ids.js';

const Sender = z.object({ name: z.string(), role: z.string() });

function view(row: Omit<BundleRow, 'bundle'>): VendorDiagnosticsView {
  const sender = Sender.safeParse(row.sentBy);
  return {
    id: row.id,
    installationId: row.installationId,
    receivedAt: row.receivedAt.toISOString(),
    note: row.note,
    sentBy: sender.success ? sender.data : null,
    sizeBytes: row.sizeBytes,
    requestId: row.requestId,
  };
}

/**
 * Diagnostics bundles (UPD-008, VCP-007): a PC sends one when its manager allows it; vendor staff
 * list them and open one. Opening is support's only way into a restaurant's logs, so every
 * opening is audited (the vendor access policy).
 */
@Injectable()
export class DiagnosticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async receive(
    installationId: string,
    upload: z.output<typeof DiagnosticsUploadRequest>,
  ): Promise<DiagnosticsUploadResponse> {
    const json = JSON.stringify(upload.bundle);
    const sizeBytes = Buffer.byteLength(json, 'utf8');
    if (sizeBytes > DIAGNOSTICS_MAX_BYTES) {
      throw new CpError(413, 'PAYLOAD_TOO_LARGE', 'The diagnostics bundle is larger than 4 MB.');
    }
    const id = newId();
    const receivedAt = new Date();
    await this.prisma.transaction(async (tx) => {
      await tx.diagnosticsBundle.create({
        data: {
          id,
          installationId,
          receivedAt,
          note: upload.note,
          sentBy: upload.sentBy ?? undefined,
          requestId: upload.requestId,
          sizeBytes,
          bundle: upload.bundle as Prisma.InputJsonObject,
        },
      });
      await this.audit.record(tx, {
        actor: `installation:${installationId}`,
        action: 'diagnostics.received',
        targetType: 'installation',
        targetId: installationId,
        details: {
          bundleId: id,
          sizeBytes,
          ...(upload.requestId !== null && { requestId: upload.requestId }),
        },
      });
    });
    return { id, receivedAt: receivedAt.toISOString() };
  }

  async list(installationId: string): Promise<VendorDiagnosticsView[]> {
    const installation = await this.prisma.installation.findUnique({
      where: { id: installationId },
    });
    if (installation === null)
      throw new CpError(404, 'NOT_FOUND', 'The installation was not found.');
    const rows = await this.prisma.diagnosticsBundle.findMany({
      where: { installationId },
      omit: { bundle: true },
      orderBy: { receivedAt: 'desc' },
      take: 100,
    });
    return rows.map(view);
  }

  /** Opens a bundle for a vendor staff member; audited (VCP-007, SEC-018). */
  async open(id: string, actor: string): Promise<VendorDiagnosticsDetail> {
    return this.prisma.transaction(async (tx) => {
      const row = await tx.diagnosticsBundle.findUnique({ where: { id } });
      if (row === null)
        throw new CpError(404, 'NOT_FOUND', 'The diagnostics bundle was not found.');
      await this.audit.record(tx, {
        actor,
        action: 'diagnostics.opened',
        targetType: 'installation',
        targetId: row.installationId,
        details: { bundleId: id },
      });
      return { ...view(row), bundle: DiagnosticsBundle.parse(row.bundle) };
    });
  }
}
