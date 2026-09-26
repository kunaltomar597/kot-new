import { Injectable } from '@nestjs/common';
import type {
  ComboRequest,
  ItemRequest,
  MenuImportReport,
  MenuImportRequest,
  MenuTemplateResponse,
} from '@rp/contracts';
import { ItemRequest as ItemRequestSchema, MENU_IMPORT_MAX_BYTES } from '@rp/contracts';
import {
  type ImportRef,
  type MenuImportContext,
  type MenuImportPlan,
  type MenuImportSheets,
  parseCsv,
  planMenuImport,
} from '@rp/domain';
import { AuditService } from '../../audit/audit.service.js';
import type { Principal } from '../../auth/principal.js';
import { PrismaService, type TransactionClient } from '../../database/prisma.service.js';
import { lockSetup } from '../../restaurant/setup-changes.js';
import { MenuAdminService } from '../menu-admin.service.js';
import { MenuPublishService } from '../menu-publish.service.js';
import { buildMenuTemplate, MENU_TEMPLATE_FILENAME } from './menu-template.js';
import { readWorkbook } from './workbook.js';

/** A 150-item menu writes a few thousand rows; the default 15 s is not enough on a slow PC. */
const IMPORT_TIMEOUT_MS = 120_000;

type Sheets = { ok: true; sheets: MenuImportSheets } | { ok: false; report: MenuImportReport };

const refused = (message: string): MenuImportReport => ({
  ok: false,
  committed: false,
  issues: [{ sheet: 'Items', row: null, column: null, message }],
  summary: null,
  menuVersion: null,
});

/**
 * Menu import (P1-05, ONB-005, ONB-009): reads the template (.xlsx or CSV sheets), plans it with
 * `@rp/domain` `planMenuImport` against the restaurant's setup, and writes the plan through the
 * menu services in one transaction with the setup lock, then publishes. Every entry written is
 * audited as the menu editor would audit it, plus one MENU_IMPORTED entry with the summary.
 */
@Injectable()
export class MenuImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly admin: MenuAdminService,
    private readonly publisher: MenuPublishService,
  ) {}

  async template(): Promise<MenuTemplateResponse> {
    return {
      filename: MENU_TEMPLATE_FILENAME,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      contentBase64: (await buildMenuTemplate()).toString('base64'),
    };
  }

  async check(principal: Principal, request: MenuImportRequest): Promise<MenuImportReport> {
    const read = await this.sheetsOf(request);
    if (!read.ok) return read.report;
    const context = await this.contextOf(this.prisma, principal.restaurantId);
    const result = planMenuImport(read.sheets, context);
    return result.ok
      ? { ok: true, committed: false, issues: [], summary: result.summary, menuVersion: null }
      : {
          ok: false,
          committed: false,
          issues: [...result.issues],
          summary: null,
          menuVersion: null,
        };
  }

  async commit(principal: Principal, request: MenuImportRequest): Promise<MenuImportReport> {
    const read = await this.sheetsOf(request);
    if (!read.ok) return read.report;
    return this.prisma.transaction(
      async (tx) => {
        await lockSetup(tx);
        // Planned inside the lock, so nobody changes the menu between the check and the write.
        const result = planMenuImport(
          read.sheets,
          await this.contextOf(tx, principal.restaurantId),
        );
        if (!result.ok) {
          return {
            ok: false,
            committed: false,
            issues: [...result.issues],
            summary: null,
            menuVersion: null,
          };
        }
        await this.write(tx, principal, result.plan);
        await this.audit.record(tx, {
          action: 'MENU_IMPORTED',
          entityType: 'menu',
          entityId: null,
          actorId: principal.staffId,
          deviceId: principal.deviceId,
          restaurantId: principal.restaurantId,
          before: null,
          after: { ...result.summary, format: request.file.format },
          reason: null,
        });
        const published = await this.publisher.publishIn(tx, principal);
        return {
          ok: true,
          committed: true,
          issues: [],
          summary: result.summary,
          menuVersion: published.version,
        };
      },
      { timeout: IMPORT_TIMEOUT_MS },
    );
  }

  private async write(
    tx: TransactionClient,
    principal: Principal,
    plan: MenuImportPlan,
  ): Promise<void> {
    const ids = new Map<string, string>();
    const idOf = (ref: ImportRef): string => {
      if ('existingId' in ref) return ref.existingId;
      const id = ids.get(ref.newKey);
      if (id === undefined) throw new Error(`The import plan refers to ${ref.newKey} before it`);
      return id;
    };
    for (const category of plan.categories) {
      const view = await this.admin.createCategoryIn(tx, principal, {
        name: category.name,
        parentId: category.parent === null ? null : idOf(category.parent),
        displayOrder: category.displayOrder,
      });
      ids.set(category.key, view.id);
    }
    for (const group of plan.modifierGroups) {
      const view = await this.admin.createModifierGroupIn(tx, principal, {
        name: group.name,
        minSelections: group.minSelections,
        maxSelections: group.maxSelections,
        options: group.options.map((option) => ({ ...option, available: true })),
      });
      ids.set(group.key, view.id);
    }
    for (const item of plan.items) {
      // The same schema the menu editor's requests pass through; the plan already meets it.
      const request: ItemRequest = ItemRequestSchema.parse({
        categoryId: idOf(item.category),
        name: item.name,
        shortCode: item.shortCode,
        description: item.description,
        photoId: null,
        basePrice: item.basePrice,
        taxGroupId: item.taxGroupId,
        foodType: item.foodType,
        spiceLevel: item.spiceLevel,
        tags: item.tags,
        stationId: item.stationId,
        prepTimeMinutes: item.prepTimeMinutes,
        displayOrder: item.displayOrder,
        channels: item.channels,
        variants: item.variants,
        modifierGroupIds: item.modifierGroups.map(idOf),
        synonyms: item.synonyms,
        repeatable: item.repeatable,
        externalId: item.externalId,
        reason: 'Menu import',
      });
      const view = await this.admin.createItemIn(tx, principal, request);
      ids.set(item.key, view.id);
    }
    for (const combo of plan.combos) {
      const request: ComboRequest = {
        components: combo.components.map((component) =>
          component.kind === 'FIXED'
            ? { kind: 'FIXED', itemId: idOf(component.item), quantity: component.quantity }
            : {
                kind: 'CHOICE',
                label: component.label,
                itemIds: component.items.map(idOf),
                quantity: component.quantity,
              },
        ),
        activeFrom: combo.activeFrom,
        activeUntil: combo.activeUntil,
        timeWindow: combo.timeWindow,
        reason: 'Menu import',
      };
      await this.publisher.setComboIn(tx, principal, idOf({ newKey: combo.itemKey }), request);
    }
  }

  private async sheetsOf(request: MenuImportRequest): Promise<Sheets> {
    const { file } = request;
    if (file.format === 'XLSX') {
      const content = Buffer.from(file.contentBase64, 'base64');
      if (content.length > MENU_IMPORT_MAX_BYTES) {
        return { ok: false, report: refused('The file is larger than 5 MB.') };
      }
      const workbook = await readWorkbook(content);
      return workbook.ok
        ? { ok: true, sheets: workbook.sheets }
        : { ok: false, report: refused(workbook.message) };
    }
    const sheets: Record<string, string[][]> = {};
    const issues: MenuImportReport['issues'] = [];
    for (const [name, text] of Object.entries(file.sheets)) {
      try {
        sheets[name] = parseCsv(text);
      } catch {
        issues.push({
          sheet: name as MenuImportReport['issues'][number]['sheet'],
          row: null,
          column: null,
          message: 'A quoted cell is not closed. Save the sheet again as CSV.',
        });
      }
    }
    if (issues.length > 0) {
      return {
        ok: false,
        report: { ok: false, committed: false, issues, summary: null, menuVersion: null },
      };
    }
    return { ok: true, sheets };
  }

  private async contextOf(
    db: TransactionClient | PrismaService,
    restaurantId: string,
  ): Promise<MenuImportContext> {
    const active = { restaurantId, archivedAt: null };
    const [taxGroups, stations, categories, modifierGroups, items] = await Promise.all([
      db.taxGroup.findMany({ where: active, select: { id: true, name: true } }),
      db.station.findMany({ where: active, select: { id: true, name: true } }),
      db.category.findMany({
        where: active,
        select: { id: true, name: true, parentId: true, displayOrder: true },
      }),
      db.modifierGroup.findMany({ where: active, select: { id: true, name: true } }),
      db.item.findMany({
        where: active,
        select: { id: true, name: true, shortCode: true, combo: { select: { id: true } } },
      }),
    ]);
    return {
      taxGroups,
      stations,
      categories,
      modifierGroups,
      items: items.map(({ combo, ...item }) => ({ ...item, isCombo: combo !== null })),
    };
  }
}
