import { Injectable } from '@nestjs/common';
import type { SectionRequest, SectionView, TableRequest, TableView } from '@rp/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import type { DiningTable, Section } from '../generated/prisma/client.js';
import { announceSetupChange, lockSetup } from '../restaurant/setup-changes.js';

/** Active table tablets bound to a table (AUTH-009). */
const WITH_TABLETS = {
  devices: { where: { type: 'TABLE_TABLET', status: 'ACTIVE' }, select: { id: true } },
} as const;

const TABLE_ORDER = [{ displayOrder: 'asc' }, { createdAt: 'asc' }] as const;

type TableRow = DiningTable & { devices: { id: string }[] };
type SectionRow = Section & { tables: TableRow[] };

function toTableView(table: TableRow): TableView {
  return {
    id: table.id,
    label: table.label,
    capacity: table.capacity,
    sectionId: table.sectionId,
    state: table.state,
    displayOrder: table.displayOrder,
    tabletDeviceIds: table.devices.map((device) => device.id),
    archivedAt: table.archivedAt?.toISOString() ?? null,
    updatedAt: table.updatedAt.toISOString(),
  };
}

function toSectionView(section: SectionRow): SectionView {
  return {
    id: section.id,
    name: section.name,
    displayOrder: section.displayOrder,
    archivedAt: section.archivedAt?.toISOString() ?? null,
    tables: section.tables.map(toTableView),
    updatedAt: section.updatedAt.toISOString(),
  };
}

function sectionNotFound(): AppError {
  return new AppError(404, 'SECTION_NOT_FOUND', 'There is no such section.');
}

function tableNotFound(): AppError {
  return new AppError(404, 'TABLE_NOT_FOUND', 'There is no such table.');
}

/**
 * The floor (P1-02a, TBL-001, ONB-004 step 5): sections and their tables. Managers and the Owner
 * change it (BRD §4.2 "manage staff, sections"); every change is audited (AUD-001) and announced
 * with `RestaurantChanged { part: 'FLOOR' }`. Sections and tables are archived, never deleted, and
 * a table is archived only when it is free and no tablet is paired to it.
 */
@Injectable()
export class FloorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async floor(restaurantId: string): Promise<SectionView[]> {
    const sections = await this.prisma.section.findMany({
      where: { restaurantId },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      include: { tables: { orderBy: [...TABLE_ORDER], include: WITH_TABLETS } },
    });
    return sections.map(toSectionView);
  }

  createSection(principal: Principal, request: SectionRequest): Promise<SectionView> {
    return this.change(principal, async (tx) => {
      await this.assertSectionNameFree(tx, principal.restaurantId, request.name, null);
      const section = await tx.section.create({
        data: {
          restaurantId: principal.restaurantId,
          name: request.name,
          displayOrder: request.displayOrder,
        },
      });
      await this.record(tx, principal, 'SECTION_CREATED', 'section', section.id, {
        before: null,
        after: { name: section.name, displayOrder: section.displayOrder },
      });
      return { changed: true, result: await this.sectionView(tx, section.id) };
    });
  }

  updateSection(
    principal: Principal,
    sectionId: string,
    request: SectionRequest,
  ): Promise<SectionView> {
    return this.change(principal, async (tx) => {
      const existing = await this.findSection(tx, principal.restaurantId, sectionId);
      if (existing.archivedAt !== null) {
        throw new AppError(
          409,
          'SECTION_ARCHIVED',
          'This section is archived. Restore it before changing it.',
        );
      }
      await this.assertSectionNameFree(tx, principal.restaurantId, request.name, sectionId);
      if (existing.name === request.name && existing.displayOrder === request.displayOrder) {
        return { changed: false, result: await this.sectionView(tx, sectionId) };
      }
      await tx.section.update({
        where: { id: sectionId },
        data: { name: request.name, displayOrder: request.displayOrder },
      });
      await this.record(tx, principal, 'SECTION_CHANGED', 'section', sectionId, {
        before: { name: existing.name, displayOrder: existing.displayOrder },
        after: { name: request.name, displayOrder: request.displayOrder },
      });
      return { changed: true, result: await this.sectionView(tx, sectionId) };
    });
  }

  archiveSection(principal: Principal, sectionId: string, reason: string): Promise<SectionView> {
    return this.change(principal, async (tx) => {
      const existing = await this.findSection(tx, principal.restaurantId, sectionId);
      if (existing.archivedAt !== null) {
        return { changed: false, result: await this.sectionView(tx, sectionId) };
      }
      const tableCount = await tx.diningTable.count({ where: { sectionId, archivedAt: null } });
      if (tableCount > 0) {
        throw new AppError(
          409,
          'SECTION_NOT_EMPTY',
          `The section still has ${String(tableCount)} tables. Move or archive them first.`,
          { tableCount },
        );
      }
      const section = await tx.section.update({
        where: { id: sectionId },
        data: { archivedAt: new Date() },
      });
      await this.record(tx, principal, 'SECTION_ARCHIVED', 'section', sectionId, {
        before: { archivedAt: null },
        after: { archivedAt: section.archivedAt?.toISOString() ?? null },
        reason,
      });
      return { changed: true, result: await this.sectionView(tx, sectionId) };
    });
  }

  restoreSection(principal: Principal, sectionId: string): Promise<SectionView> {
    return this.change(principal, async (tx) => {
      const existing = await this.findSection(tx, principal.restaurantId, sectionId);
      if (existing.archivedAt === null) {
        return { changed: false, result: await this.sectionView(tx, sectionId) };
      }
      await this.assertSectionNameFree(tx, principal.restaurantId, existing.name, sectionId);
      await tx.section.update({ where: { id: sectionId }, data: { archivedAt: null } });
      await this.record(tx, principal, 'SECTION_RESTORED', 'section', sectionId, {
        before: { archivedAt: existing.archivedAt.toISOString() },
        after: { archivedAt: null },
      });
      return { changed: true, result: await this.sectionView(tx, sectionId) };
    });
  }

  createTable(principal: Principal, request: TableRequest): Promise<TableView> {
    return this.change(principal, async (tx) => {
      await this.assertActiveSection(tx, principal.restaurantId, request.sectionId);
      await this.assertLabelFree(tx, principal.restaurantId, request.label, null);
      const table = await tx.diningTable.create({
        data: {
          restaurantId: principal.restaurantId,
          sectionId: request.sectionId,
          label: request.label,
          capacity: request.capacity,
          displayOrder: request.displayOrder,
        },
        include: WITH_TABLETS,
      });
      await this.record(tx, principal, 'TABLE_CREATED', 'table', table.id, {
        before: null,
        after: this.tableSnapshot(table),
      });
      return { changed: true, result: toTableView(table) };
    });
  }

  updateTable(principal: Principal, tableId: string, request: TableRequest): Promise<TableView> {
    return this.change(principal, async (tx) => {
      const existing = await this.findTable(tx, principal.restaurantId, tableId);
      if (existing.archivedAt !== null) {
        throw new AppError(
          409,
          'TABLE_ARCHIVED',
          'This table is archived. Restore it before changing it.',
        );
      }
      if (request.sectionId !== existing.sectionId) {
        await this.assertActiveSection(tx, principal.restaurantId, request.sectionId);
      }
      await this.assertLabelFree(tx, principal.restaurantId, request.label, tableId);
      const before = this.tableSnapshot(existing);
      const after = {
        label: request.label,
        capacity: request.capacity,
        sectionId: request.sectionId,
        displayOrder: request.displayOrder,
      };
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return { changed: false, result: toTableView(existing) };
      }
      const table = await tx.diningTable.update({
        where: { id: tableId },
        data: after,
        include: WITH_TABLETS,
      });
      await this.record(tx, principal, 'TABLE_CHANGED', 'table', tableId, { before, after });
      return { changed: true, result: toTableView(table) };
    });
  }

  archiveTable(principal: Principal, tableId: string, reason: string): Promise<TableView> {
    return this.change(principal, async (tx) => {
      // Holds off a table being opened (P1-02b) until the archive commits.
      await tx.$queryRaw`SELECT 1 AS locked FROM tables WHERE id = ${tableId}::uuid FOR UPDATE`;
      const existing = await this.findTable(tx, principal.restaurantId, tableId);
      if (existing.archivedAt !== null) return { changed: false, result: toTableView(existing) };
      if (existing.state !== 'FREE') {
        throw new AppError(
          409,
          'TABLE_IN_USE',
          'Guests are seated at this table. Close it before archiving it.',
        );
      }
      if (existing.devices.length > 0) {
        throw new AppError(
          409,
          'TABLE_HAS_TABLET',
          'A table tablet is paired to this table. Move or unpair the tablet first.',
          { tabletDeviceIds: existing.devices.map((device) => device.id) },
        );
      }
      const table = await tx.diningTable.update({
        where: { id: tableId },
        data: { archivedAt: new Date() },
        include: WITH_TABLETS,
      });
      await this.record(tx, principal, 'TABLE_ARCHIVED', 'table', tableId, {
        before: { archivedAt: null },
        after: { archivedAt: table.archivedAt?.toISOString() ?? null },
        reason,
      });
      return { changed: true, result: toTableView(table) };
    });
  }

  restoreTable(principal: Principal, tableId: string): Promise<TableView> {
    return this.change(principal, async (tx) => {
      const existing = await this.findTable(tx, principal.restaurantId, tableId);
      if (existing.archivedAt === null) return { changed: false, result: toTableView(existing) };
      const section = await this.findSection(tx, principal.restaurantId, existing.sectionId);
      if (section.archivedAt !== null) {
        throw new AppError(
          409,
          'SECTION_ARCHIVED',
          "The table's section is archived. Restore the section first.",
        );
      }
      const table = await tx.diningTable.update({
        where: { id: tableId },
        data: { archivedAt: null },
        include: WITH_TABLETS,
      });
      await this.record(tx, principal, 'TABLE_RESTORED', 'table', tableId, {
        before: { archivedAt: existing.archivedAt.toISOString() },
        after: { archivedAt: null },
      });
      return { changed: true, result: toTableView(table) };
    });
  }

  /**
   * Runs one floor change under the setup lock; when it changed something, announces it to every
   * screen in the same transaction.
   */
  private change<T>(
    principal: Principal,
    work: (tx: TransactionClient) => Promise<{ changed: boolean; result: T }>,
  ): Promise<T> {
    return this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      const { changed, result } = await work(tx);
      if (changed) {
        await announceSetupChange(tx, principal.restaurantId, 'FLOOR', {
          type: 'floor',
          id: principal.restaurantId,
        });
      }
      return result;
    });
  }

  private tableSnapshot(table: DiningTable) {
    return {
      label: table.label,
      capacity: table.capacity,
      sectionId: table.sectionId,
      displayOrder: table.displayOrder,
    };
  }

  private async sectionView(tx: TransactionClient, sectionId: string): Promise<SectionView> {
    const section = await tx.section.findUniqueOrThrow({
      where: { id: sectionId },
      include: { tables: { orderBy: [...TABLE_ORDER], include: WITH_TABLETS } },
    });
    return toSectionView(section);
  }

  private async findSection(
    tx: TransactionClient,
    restaurantId: string,
    sectionId: string,
  ): Promise<Section> {
    const section = await tx.section.findFirst({ where: { id: sectionId, restaurantId } });
    if (section === null) throw sectionNotFound();
    return section;
  }

  private async findTable(
    tx: TransactionClient,
    restaurantId: string,
    tableId: string,
  ): Promise<TableRow> {
    const table = await tx.diningTable.findFirst({
      where: { id: tableId, restaurantId },
      include: WITH_TABLETS,
    });
    if (table === null) throw tableNotFound();
    return table;
  }

  private async assertActiveSection(
    tx: TransactionClient,
    restaurantId: string,
    sectionId: string,
  ): Promise<void> {
    const section = await tx.section.findFirst({
      where: { id: sectionId, restaurantId, archivedAt: null },
      select: { id: true },
    });
    if (section === null) {
      throw new AppError(
        422,
        'SECTION_NOT_FOUND',
        'There is no such active section. Choose another section, or restore it first.',
      );
    }
  }

  /** Two active sections with one name would be ambiguous on every floor screen. */
  private async assertSectionNameFree(
    tx: TransactionClient,
    restaurantId: string,
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    const clash = await tx.section.findFirst({
      where: {
        restaurantId,
        archivedAt: null,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId !== null && { NOT: { id: exceptId } }),
      },
      select: { id: true },
    });
    if (clash !== null) {
      throw new AppError(
        409,
        'SECTION_NAME_TAKEN',
        `Another section is called "${name}". Choose another name.`,
      );
    }
  }

  /** Labels identify tables on tickets and bills, so they are unique, archived tables included. */
  private async assertLabelFree(
    tx: TransactionClient,
    restaurantId: string,
    label: string,
    exceptId: string | null,
  ): Promise<void> {
    const clash = await tx.diningTable.findFirst({
      where: {
        restaurantId,
        label: { equals: label, mode: 'insensitive' },
        ...(exceptId !== null && { NOT: { id: exceptId } }),
      },
      select: { id: true, archivedAt: true },
    });
    if (clash !== null) {
      throw new AppError(
        409,
        'TABLE_LABEL_TAKEN',
        clash.archivedAt === null
          ? `Another table is labelled "${label}". Choose another label.`
          : `An archived table is labelled "${label}". Restore it instead of adding a new one.`,
        { tableId: clash.id },
      );
    }
  }

  private async record(
    tx: TransactionClient,
    principal: Principal,
    action: string,
    entityType: string,
    entityId: string,
    change: { before: unknown; after: unknown; reason?: string },
  ): Promise<void> {
    await this.audit.record(tx, {
      action,
      entityType,
      entityId,
      actorId: principal.staffId,
      deviceId: principal.deviceId,
      restaurantId: principal.restaurantId,
      before: change.before,
      after: change.after,
      reason: change.reason ?? null,
    });
  }
}
