import { Injectable } from '@nestjs/common';
import { InvoiceSeparator, type InvoiceSeriesRequest, type InvoiceSeriesView } from '@rp/contracts';
import {
  calendarDateOf,
  canonicalJson,
  financialYearOf,
  formatInvoiceNumber,
  type InvoiceSeriesConfig,
  validateInvoiceSeries,
} from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import type { InvoiceSeries } from '../generated/prisma/client.js';
import { announceSetupChange, lockSetup } from './setup-changes.js';

function configOf(series: {
  prefix: string;
  includeFinancialYear: boolean;
  separator: string;
  sequencePadding: number;
}): InvoiceSeriesConfig {
  return {
    prefix: series.prefix,
    includeFinancialYear: series.includeFinancialYear,
    separator: InvoiceSeparator.parse(series.separator),
    sequencePadding: series.sequencePadding,
  };
}

/** What the audit log keeps of a series. */
function snapshot(series: InvoiceSeries) {
  return { name: series.name, ...configOf(series), isDefault: series.isDefault };
}

function notFound(): AppError {
  return new AppError(404, 'INVOICE_SERIES_NOT_FOUND', 'There is no such invoice series.');
}

function archived(): AppError {
  return new AppError(
    409,
    'INVOICE_SERIES_ARCHIVED',
    'This invoice series is archived and cannot be used again. Add a new series instead.',
  );
}

/**
 * Invoice series (P1-01b, BILL-003, ONB-004 step 3): prefix and format of the invoice numbers,
 * which the billing module allocates gap-free per series and financial year (ADR-0005, ADR-0007).
 * The routes need the Owner with a fresh second factor (AUTH-006).
 *
 * - Numbers are at most 16 characters (`@rp/domain` `validateInvoiceSeries`).
 * - A prefix is never used by two series, archived ones included, so numbers stay unique.
 * - Once a series has issued an invoice its format is fixed; rename it, or add a new series.
 * - Exactly one active series is the default, the one new bills use; it cannot be archived.
 */
@Injectable()
export class InvoiceSeriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(restaurantId: string): Promise<InvoiceSeriesView[]> {
    const [series, timeZone] = await Promise.all([
      this.prisma.invoiceSeries.findMany({
        where: { restaurantId },
        orderBy: { createdAt: 'asc' },
      }),
      this.timeZoneOf(this.prisma, restaurantId),
    ]);
    const counts = await this.invoiceCounts(
      this.prisma,
      series.map((item) => item.id),
    );
    return series.map((item) => this.toView(item, counts.get(item.id) ?? 0, timeZone));
  }

  create(principal: Principal, request: InvoiceSeriesRequest): Promise<InvoiceSeriesView> {
    return this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      await this.assertPrefixFree(tx, principal.restaurantId, request.prefix, null);
      this.assertValid(request);
      const hasDefault =
        (await tx.invoiceSeries.count({
          where: { restaurantId: principal.restaurantId, isDefault: true, archivedAt: null },
        })) > 0;
      const series = await tx.invoiceSeries.create({
        data: {
          restaurantId: principal.restaurantId,
          name: request.name,
          ...configOf(request),
          // The first series is the one bills use until the Owner chooses another.
          isDefault: !hasDefault,
        },
      });
      await this.record(tx, principal, 'INVOICE_SERIES_CREATED', series.id, {
        before: null,
        after: snapshot(series),
        reason: request.reason ?? null,
      });
      await this.announce(tx, principal, series.id);
      return this.toView(series, 0, await this.timeZoneOf(tx, principal.restaurantId));
    });
  }

  update(
    principal: Principal,
    seriesId: string,
    request: InvoiceSeriesRequest,
  ): Promise<InvoiceSeriesView> {
    return this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      // Waits for an invoice being issued from the series right now: billing holds the series row
      // (FOR SHARE, P1-10) from reading its format to committing the invoice, which the count
      // below then sees.
      await tx.$queryRaw`SELECT 1 AS locked FROM invoice_series WHERE id = ${seriesId}::uuid FOR UPDATE`;
      const existing = await this.find(tx, principal.restaurantId, seriesId);
      if (existing.archivedAt !== null) throw archived();
      const invoiceCount = (await this.invoiceCounts(tx, [seriesId])).get(seriesId) ?? 0;
      const formatChanged = canonicalJson(configOf(existing)) !== canonicalJson(configOf(request));
      if (formatChanged && invoiceCount > 0) {
        throw new AppError(
          409,
          'INVOICE_SERIES_FORMAT_FIXED',
          'Invoices have been issued from this series, so its prefix and format are fixed to keep ' +
            'the numbers consecutive. Rename it, or add a new series.',
          { invoiceCount },
        );
      }
      if (request.prefix !== existing.prefix) {
        await this.assertPrefixFree(tx, principal.restaurantId, request.prefix, seriesId);
      }
      this.assertValid(request);
      const timeZone = await this.timeZoneOf(tx, principal.restaurantId);
      if (!formatChanged && request.name === existing.name) {
        return this.toView(existing, invoiceCount, timeZone);
      }

      const series = await tx.invoiceSeries.update({
        where: { id: seriesId },
        data: { name: request.name, ...configOf(request) },
      });
      await this.record(tx, principal, 'INVOICE_SERIES_CHANGED', seriesId, {
        before: snapshot(existing),
        after: snapshot(series),
        reason: request.reason ?? null,
      });
      await this.announce(tx, principal, seriesId);
      return this.toView(series, invoiceCount, timeZone);
    });
  }

  archive(principal: Principal, seriesId: string, reason: string): Promise<InvoiceSeriesView> {
    return this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      const existing = await this.find(tx, principal.restaurantId, seriesId);
      const invoiceCount = (await this.invoiceCounts(tx, [seriesId])).get(seriesId) ?? 0;
      const timeZone = await this.timeZoneOf(tx, principal.restaurantId);
      if (existing.archivedAt !== null) return this.toView(existing, invoiceCount, timeZone);
      if (existing.isDefault) {
        throw new AppError(
          409,
          'INVOICE_SERIES_IS_DEFAULT',
          'New bills use this series. Make another series the default first, then archive it.',
        );
      }
      const series = await tx.invoiceSeries.update({
        where: { id: seriesId },
        data: { archivedAt: new Date() },
      });
      await this.record(tx, principal, 'INVOICE_SERIES_ARCHIVED', seriesId, {
        before: { archivedAt: null },
        after: { archivedAt: series.archivedAt?.toISOString() ?? null },
        reason,
      });
      await this.announce(tx, principal, seriesId);
      return this.toView(series, invoiceCount, timeZone);
    });
  }

  setDefault(principal: Principal, seriesId: string): Promise<InvoiceSeriesView> {
    return this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      const existing = await this.find(tx, principal.restaurantId, seriesId);
      if (existing.archivedAt !== null) throw archived();
      const invoiceCount = (await this.invoiceCounts(tx, [seriesId])).get(seriesId) ?? 0;
      const timeZone = await this.timeZoneOf(tx, principal.restaurantId);
      if (existing.isDefault) return this.toView(existing, invoiceCount, timeZone);

      const previous = await tx.invoiceSeries.findFirst({
        where: { restaurantId: principal.restaurantId, isDefault: true },
        select: { id: true },
      });
      await tx.invoiceSeries.updateMany({
        where: { restaurantId: principal.restaurantId, isDefault: true },
        data: { isDefault: false },
      });
      const series = await tx.invoiceSeries.update({
        where: { id: seriesId },
        data: { isDefault: true },
      });
      await this.record(tx, principal, 'INVOICE_SERIES_DEFAULT_CHANGED', seriesId, {
        before: { defaultSeriesId: previous?.id ?? null },
        after: { defaultSeriesId: seriesId },
        reason: null,
      });
      await this.announce(tx, principal, seriesId);
      return this.toView(series, invoiceCount, timeZone);
    });
  }

  private toView(series: InvoiceSeries, invoiceCount: number, timeZone: string): InvoiceSeriesView {
    const config = configOf(series);
    const financialYear = financialYearOf(calendarDateOf(new Date(), timeZone));
    return {
      id: series.id,
      name: series.name,
      ...config,
      isDefault: series.isDefault,
      example: formatInvoiceNumber(config, financialYear, 1),
      invoiceCount,
      archivedAt: series.archivedAt?.toISOString() ?? null,
      updatedAt: series.updatedAt.toISOString(),
    };
  }

  private async find(
    tx: TransactionClient,
    restaurantId: string,
    seriesId: string,
  ): Promise<InvoiceSeries> {
    const series = await tx.invoiceSeries.findFirst({ where: { id: seriesId, restaurantId } });
    if (series === null) throw notFound();
    return series;
  }

  private async timeZoneOf(
    client: Pick<TransactionClient, 'restaurant'>,
    restaurantId: string,
  ): Promise<string> {
    const restaurant = await client.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { timeZone: true },
    });
    return restaurant.timeZone;
  }

  private async invoiceCounts(
    client: Pick<TransactionClient, 'invoice'>,
    seriesIds: readonly string[],
  ): Promise<Map<string, number>> {
    if (seriesIds.length === 0) return new Map();
    const rows = await client.invoice.groupBy({
      by: ['seriesId'],
      where: { seriesId: { in: [...seriesIds] } },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.seriesId, row._count._all]));
  }

  private async assertPrefixFree(
    tx: TransactionClient,
    restaurantId: string,
    prefix: string,
    exceptId: string | null,
  ): Promise<void> {
    const clash = await tx.invoiceSeries.findFirst({
      where: { restaurantId, prefix, ...(exceptId !== null && { NOT: { id: exceptId } }) },
      select: { archivedAt: true },
    });
    if (clash !== null) {
      throw new AppError(
        409,
        'INVOICE_SERIES_PREFIX_TAKEN',
        clash.archivedAt === null
          ? `Another series already uses the prefix "${prefix}". Choose another prefix.`
          : `An archived series used the prefix "${prefix}"; prefixes are never reused, so ` +
              'invoice numbers stay unique. Choose another prefix.',
      );
    }
  }

  private assertValid(request: InvoiceSeriesRequest): void {
    const problems = validateInvoiceSeries(configOf(request));
    if (problems.length > 0) {
      throw new AppError(422, 'INVOICE_SERIES_INVALID', problems.join('. '), { problems });
    }
  }

  private async announce(
    tx: TransactionClient,
    principal: Principal,
    seriesId: string,
  ): Promise<void> {
    await announceSetupChange(tx, principal.restaurantId, 'INVOICE_SERIES', {
      type: 'invoice_series',
      id: seriesId,
    });
  }

  private async record(
    tx: TransactionClient,
    principal: Principal,
    action: string,
    seriesId: string,
    change: { before: unknown; after: unknown; reason: string | null },
  ): Promise<void> {
    await this.audit.record(tx, {
      action,
      entityType: 'invoice_series',
      entityId: seriesId,
      actorId: principal.staffId,
      deviceId: principal.deviceId,
      restaurantId: principal.restaurantId,
      ...change,
    });
  }
}
