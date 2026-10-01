import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  TableQrCodesResponse,
  TableQrView,
  TableTentsRequest,
  TableTentsResponse,
} from '@rp/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { announceSetupChange, lockSetup } from '../restaurant/setup-changes.js';
import { tableTentsPdf } from './table-tents.js';

/** A table's QR token: 128 random bits, base64url (QR-001; the relay checks the length). */
export function newTableToken(): string {
  return randomBytes(16).toString('base64url');
}

/** What the relay keeps of a token: its SHA-256 over the UTF-8 bytes, in hex (ADR-0015). */
export function tableTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const TABLE_ORDER = [{ displayOrder: 'asc' }, { createdAt: 'asc' }] as const;

interface TableRow {
  readonly id: string;
  readonly label: string;
  readonly qrToken: string | null;
  readonly qrTokenIssuedAt: Date | null;
  readonly section: { readonly name: string };
}

/**
 * Table QR codes (P5-04, QR-001, ONB-004 step 10). This PC keeps each token so the tent can be
 * printed again; the relay gets only its hash (P5-03a sends it with the tables). A new code
 * replaces the old one at once: the relay stops opening the old code as soon as it hears.
 * Every issue is audited without the token (AUD-001) and announced as a floor change.
 */
@Injectable()
export class TableQrService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(principal: Principal): Promise<TableQrCodesResponse> {
    return this.view(await this.tables(this.prisma, principal.restaurantId));
  }

  /** Gives every active table without a code one; tables with a code keep it. */
  issueMissing(principal: Principal): Promise<TableQrCodesResponse> {
    return this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      const missing = (await this.tables(tx, principal.restaurantId)).filter(
        (table) => table.qrToken === null,
      );
      const now = new Date();
      for (const table of missing) {
        await tx.diningTable.update({
          where: { id: table.id },
          data: { qrToken: newTableToken(), qrTokenIssuedAt: now },
        });
      }
      if (missing.length > 0) {
        await this.audit.record(tx, {
          action: 'TABLE_QR_CODES_ISSUED',
          entityType: 'floor',
          entityId: principal.restaurantId,
          actorId: principal.staffId,
          deviceId: principal.deviceId,
          restaurantId: principal.restaurantId,
          before: null,
          after: { tables: missing.map((table) => table.label) },
          reason: null,
        });
        await announceSetupChange(tx, principal.restaurantId, 'FLOOR', {
          type: 'floor',
          id: principal.restaurantId,
        });
      }
      return this.view(await this.tables(tx, principal.restaurantId));
    });
  }

  /** A new code for one table: the printed one stops working (QR-001). */
  regenerate(principal: Principal, tableId: string, reason: string): Promise<TableQrView> {
    return this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      const before = (await this.tables(tx, principal.restaurantId)).find(
        (table) => table.id === tableId,
      );
      if (before === undefined) {
        throw new AppError(404, 'TABLE_NOT_FOUND', 'There is no such active table.');
      }
      const issuedAt = new Date();
      await tx.diningTable.update({
        where: { id: tableId },
        data: { qrToken: newTableToken(), qrTokenIssuedAt: issuedAt },
      });
      await this.audit.record(tx, {
        action: 'TABLE_QR_CODE_REGENERATED',
        entityType: 'table',
        entityId: tableId,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        before: { label: before.label, issuedAt: before.qrTokenIssuedAt?.toISOString() ?? null },
        after: { label: before.label, issuedAt: issuedAt.toISOString() },
        reason,
      });
      await announceSetupChange(tx, principal.restaurantId, 'FLOOR', {
        type: 'floor',
        id: principal.restaurantId,
      });
      const after = (await this.tables(tx, principal.restaurantId)).find(
        (table) => table.id === tableId,
      );
      if (after === undefined) throw new Error('The table disappeared');
      return this.tableView(after);
    });
  }

  /** The tents to print (ONB-004 step 10); tables without a code are left out. */
  async tents(principal: Principal, request: TableTentsRequest): Promise<TableTentsResponse> {
    const siteUrl = this.config.qrSiteUrl;
    if (siteUrl === undefined) {
      throw new AppError(
        409,
        'QR_SITE_NOT_SET',
        'The QR menu site is not set up on this PC yet (RP_QR_SITE_URL).',
      );
    }
    const [tables, restaurant] = await Promise.all([
      this.tables(this.prisma, principal.restaurantId),
      this.prisma.restaurant.findUniqueOrThrow({
        where: { id: principal.restaurantId },
        select: { displayName: true, accentColor: true, timeZone: true },
      }),
    ]);
    const wanted = request.tableIds === undefined ? undefined : new Set(request.tableIds);
    const printable = tables.flatMap((table) =>
      table.qrToken === null || (wanted !== undefined && !wanted.has(table.id))
        ? []
        : [{ label: table.label, url: `${siteUrl}/t/${table.qrToken}` }],
    );
    if (printable.length === 0) {
      throw new AppError(409, 'NO_QR_CODES', 'None of these tables has a QR code yet.');
    }
    const generatedAt = new Date();
    const { pdf, pages } = await tableTentsPdf(
      printable,
      { restaurantName: restaurant.displayName, accentColor: restaurant.accentColor },
      request.size,
      { generatedAt: generatedAt.toISOString() },
    );
    const day = generatedAt.toLocaleDateString('en-CA', { timeZone: restaurant.timeZone });
    return {
      filename: `table-tents_${request.size}_${day}.pdf`,
      contentType: 'application/pdf',
      encoding: 'base64',
      content: pdf.toString('base64'),
      pages,
    };
  }

  /** Active tables in floor order: sections, then tables, as staff see them. */
  private tables(
    client: PrismaService | TransactionClient,
    restaurantId: string,
  ): Promise<TableRow[]> {
    return client.diningTable.findMany({
      where: { restaurantId, archivedAt: null, section: { archivedAt: null } },
      orderBy: [{ section: { displayOrder: 'asc' } }, ...TABLE_ORDER],
      select: {
        id: true,
        label: true,
        qrToken: true,
        qrTokenIssuedAt: true,
        section: { select: { name: true } },
      },
    });
  }

  private view(tables: readonly TableRow[]): TableQrCodesResponse {
    return {
      siteUrl: this.config.qrSiteUrl ?? null,
      tables: tables.map((table) => this.tableView(table)),
    };
  }

  private tableView(table: TableRow): TableQrView {
    const siteUrl = this.config.qrSiteUrl;
    return {
      tableId: table.id,
      label: table.label,
      sectionName: table.section.name,
      hasCode: table.qrToken !== null,
      url: table.qrToken === null || siteUrl === undefined ? null : `${siteUrl}/t/${table.qrToken}`,
      issuedAt: table.qrTokenIssuedAt?.toISOString() ?? null,
    };
  }
}
