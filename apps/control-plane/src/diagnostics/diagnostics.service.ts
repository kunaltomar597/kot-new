import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  DIAGNOSTICS_KEEP_DAYS,
  DIAGNOSTICS_MAX_BYTES,
  DIAGNOSTICS_REQUEST_DAYS,
  type DiagnosticsRequestView,
  type PendingDiagnosticsRequest,
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
import type {
  DiagnosticsBundle as BundleRow,
  DiagnosticsRequest as RequestRow,
  Prisma,
} from '../generated/prisma/client.js';
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

function requestView(row: RequestRow, now: Date): DiagnosticsRequestView {
  const answeredBy = Sender.safeParse(row.answeredBy);
  return {
    id: row.id,
    installationId: row.installationId,
    requestedBy: row.requesterName,
    reason: row.reason,
    requestedAt: row.requestedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    state: row.state === 'PENDING' && row.expiresAt <= now ? 'EXPIRED' : row.state,
    answeredAt: row.answeredAt?.toISOString() ?? null,
    answeredBy: answeredBy.success ? answeredBy.data : null,
    bundleId: row.bundleId,
  };
}

/** How often bundles past their keeping time are looked for. */
const PURGE_EVERY_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const closed = () =>
  new CpError(
    409,
    'DIAGNOSTICS_REQUEST_CLOSED',
    'This request was already answered or has lapsed.',
  );

/**
 * Diagnostics bundles (UPD-008, VCP-007): a PC sends one when its manager allows it; vendor staff
 * list them and open one. Opening is support's only way into a restaurant's logs, so every
 * opening is audited (the vendor access policy). A bundle is deleted 30 days after it arrived,
 * audited (threat CP-I2); the request it answered keeps its id.
 */
@Injectable()
export class DiagnosticsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DiagnosticsService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      void this.purge().catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Old diagnostics bundles stay for now');
      });
    }, PURGE_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  /** Deletes the bundles kept 30 days, each PC's audited together; returns how many. */
  async purge(now = new Date()): Promise<number> {
    const old = await this.prisma.diagnosticsBundle.findMany({
      where: { receivedAt: { lt: new Date(now.getTime() - DIAGNOSTICS_KEEP_DAYS * DAY_MS) } },
      select: { id: true, installationId: true },
      orderBy: { receivedAt: 'asc' },
      take: 500,
    });
    const byInstallation = new Map<string, string[]>();
    for (const row of old) {
      byInstallation.set(row.installationId, [
        ...(byInstallation.get(row.installationId) ?? []),
        row.id,
      ]);
    }
    for (const [installationId, ids] of byInstallation) {
      await this.prisma.transaction(async (tx) => {
        await tx.diagnosticsBundle.deleteMany({ where: { id: { in: ids } } });
        await this.audit.record(tx, {
          actor: 'system:retention',
          action: 'diagnostics.removed',
          targetType: 'installation',
          targetId: installationId,
          details: { bundleIds: ids, keptDays: DIAGNOSTICS_KEEP_DAYS },
        });
      });
    }
    return old.length;
  }

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
      // Sent for a support request: it must be this PC's, and still open (P7-08b).
      if (upload.requestId !== null) {
        const asked = await tx.diagnosticsRequest.findUnique({ where: { id: upload.requestId } });
        if (asked?.installationId !== installationId) {
          throw new CpError(404, 'NOT_FOUND', 'No such request for this PC.');
        }
        if (asked.state !== 'PENDING' || asked.expiresAt <= receivedAt) throw closed();
        await tx.diagnosticsRequest.update({
          where: { id: asked.id },
          data: {
            state: 'FULFILLED',
            answeredAt: receivedAt,
            answeredBy: upload.sentBy ?? undefined,
            bundleId: id,
          },
        });
      }
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

  // --------------------------------------------------------- requests (P7-08b)

  /** Support asks an active PC's restaurant for diagnostics, with a reason; audited. */
  async request(
    installationId: string,
    reason: string,
    principal: { readonly userId: string; readonly actor: string },
    now = new Date(),
  ): Promise<DiagnosticsRequestView> {
    return this.prisma.transaction(async (tx) => {
      const installation = await tx.installation.findUnique({ where: { id: installationId } });
      if (installation === null) {
        throw new CpError(404, 'NOT_FOUND', 'The installation was not found.');
      }
      if (installation.status !== 'ACTIVE') {
        throw new CpError(
          409,
          'INSTALLATION_NOT_ACTIVE',
          'Only an activated PC can send diagnostics.',
        );
      }
      const requester = await tx.vendorUser.findUnique({
        where: { id: principal.userId },
        select: { name: true },
      });
      const row = await tx.diagnosticsRequest.create({
        data: {
          id: newId(),
          installationId,
          requestedBy: principal.actor,
          requesterName: requester?.name ?? 'Support',
          reason,
          requestedAt: now,
          expiresAt: new Date(now.getTime() + DIAGNOSTICS_REQUEST_DAYS * 86_400_000),
        },
      });
      await this.audit.record(tx, {
        actor: principal.actor,
        action: 'diagnostics.requested',
        targetType: 'installation',
        targetId: installationId,
        details: { requestId: row.id, reason },
      });
      return requestView(row, now);
    });
  }

  async requests(installationId: string, now = new Date()): Promise<DiagnosticsRequestView[]> {
    const installation = await this.prisma.installation.findUnique({
      where: { id: installationId },
    });
    if (installation === null)
      throw new CpError(404, 'NOT_FOUND', 'The installation was not found.');
    const rows = await this.prisma.diagnosticsRequest.findMany({
      where: { installationId },
      orderBy: { requestedAt: 'desc' },
      take: 100,
    });
    return rows.map((row) => requestView(row, now));
  }

  /** The open requests a PC's heartbeat answer carries, oldest first. */
  async pendingFor(installationId: string, now = new Date()): Promise<PendingDiagnosticsRequest[]> {
    const rows = await this.prisma.diagnosticsRequest.findMany({
      where: { installationId, state: 'PENDING', expiresAt: { gt: now } },
      orderBy: { requestedAt: 'asc' },
      take: 10,
    });
    return rows.map((row) => ({
      id: row.id,
      requestedBy: row.requesterName,
      reason: row.reason,
      requestedAt: row.requestedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    }));
  }

  /** The restaurant's manager declined; audited as the PC, with the manager's name. */
  async decline(
    installationId: string,
    id: string,
    by: { readonly name: string; readonly role: string },
    now = new Date(),
  ): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      const asked = await tx.diagnosticsRequest.findUnique({ where: { id } });
      if (asked?.installationId !== installationId) {
        throw new CpError(404, 'NOT_FOUND', 'No such request for this PC.');
      }
      if (asked.state !== 'PENDING' || asked.expiresAt <= now) throw closed();
      await tx.diagnosticsRequest.update({
        where: { id },
        data: { state: 'DECLINED', answeredAt: now, answeredBy: by },
      });
      await this.audit.record(tx, {
        actor: `installation:${installationId}`,
        action: 'diagnostics.request_declined',
        targetType: 'installation',
        targetId: installationId,
        details: { requestId: id, by: by.name },
      });
    });
  }
}
