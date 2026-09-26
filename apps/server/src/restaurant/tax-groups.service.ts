import { Injectable } from '@nestjs/common';
import type { TaxGroupRequest, TaxGroupView } from '@rp/contracts';
import { canonicalJson, totalRateBp, validateTaxGroup } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { newId } from '../common/ids.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import type { TaxComponent, TaxGroup } from '../generated/prisma/client.js';
import { announceSetupChange, lockSetup } from './setup-changes.js';

type TaxGroupRow = TaxGroup & { components: TaxComponent[] };

const WITH_COMPONENTS = { components: { orderBy: { displayOrder: 'asc' } } } as const;

/** What the audit log keeps of a tax group. */
function snapshot(group: {
  name: string;
  sacCode: string | null;
  components: readonly { code: string; rateBp: number }[];
}) {
  return {
    name: group.name,
    sacCode: group.sacCode,
    components: group.components.map(({ code, rateBp }) => ({ code, rateBp })),
  };
}

function toView(group: TaxGroupRow, itemCount: number): TaxGroupView {
  const components = group.components.map(({ code, rateBp }) => ({ code, rateBp }));
  return {
    id: group.id,
    name: group.name,
    sacCode: group.sacCode,
    components,
    totalRateBp: totalRateBp({ id: group.id, name: group.name, components }),
    itemCount,
    archivedAt: group.archivedAt?.toISOString() ?? null,
    updatedAt: group.updatedAt.toISOString(),
  };
}

function notFound(): AppError {
  return new AppError(404, 'TAX_GROUP_NOT_FOUND', 'There is no such tax group.');
}

/**
 * Tax groups (P1-01b, BILL-004): the rates are the restaurant's data, entered in the setup wizard
 * (ONB-004 step 2), never constants. The routes need the Owner with a fresh second factor
 * (AUTH-006). New rates apply to bills from then on; issued invoices keep their own tax lines.
 * Groups are archived, never deleted (BRD §9.4), and only when no menu item uses them.
 */
@Injectable()
export class TaxGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(restaurantId: string): Promise<TaxGroupView[]> {
    const groups = await this.prisma.taxGroup.findMany({
      where: { restaurantId },
      include: WITH_COMPONENTS,
      orderBy: { createdAt: 'asc' },
    });
    const counts = await this.itemCounts(
      this.prisma,
      groups.map((group) => group.id),
    );
    return groups.map((group) => toView(group, counts.get(group.id) ?? 0));
  }

  create(principal: Principal, request: TaxGroupRequest): Promise<TaxGroupView> {
    return this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      await this.assertNameFree(tx, principal.restaurantId, request.name, null);
      const id = newId();
      this.assertValid(id, request);
      const group = await tx.taxGroup.create({
        data: {
          id,
          restaurantId: principal.restaurantId,
          name: request.name,
          sacCode: request.sacCode,
          components: { create: this.componentRows(principal.restaurantId, request) },
        },
        include: WITH_COMPONENTS,
      });
      await this.record(tx, principal, 'TAX_GROUP_CREATED', group.id, {
        before: null,
        after: snapshot(group),
        reason: request.reason ?? null,
      });
      await announceSetupChange(tx, principal.restaurantId, 'TAX_GROUPS', {
        type: 'tax_group',
        id: group.id,
      });
      return toView(group, 0);
    });
  }

  update(
    principal: Principal,
    taxGroupId: string,
    request: TaxGroupRequest,
  ): Promise<TaxGroupView> {
    return this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      const existing = await this.find(tx, principal.restaurantId, taxGroupId);
      if (existing.archivedAt !== null) {
        throw new AppError(
          409,
          'TAX_GROUP_ARCHIVED',
          'This tax group is archived and cannot be changed. Add a new tax group instead.',
        );
      }
      await this.assertNameFree(tx, principal.restaurantId, request.name, taxGroupId);
      this.assertValid(taxGroupId, request);
      const before = snapshot(existing);
      const itemCount = (await this.itemCounts(tx, [taxGroupId])).get(taxGroupId) ?? 0;
      if (canonicalJson(before) === canonicalJson(snapshot(request))) {
        return toView(existing, itemCount);
      }

      // The components belong to the group; invoices copy code and rate into their own tax lines.
      await tx.taxComponent.deleteMany({ where: { taxGroupId } });
      const group = await tx.taxGroup.update({
        where: { id: taxGroupId },
        data: {
          name: request.name,
          sacCode: request.sacCode,
          components: { create: this.componentRows(principal.restaurantId, request) },
        },
        include: WITH_COMPONENTS,
      });
      await this.record(tx, principal, 'TAX_GROUP_CHANGED', taxGroupId, {
        before,
        after: snapshot(group),
        reason: request.reason ?? null,
      });
      await announceSetupChange(tx, principal.restaurantId, 'TAX_GROUPS', {
        type: 'tax_group',
        id: taxGroupId,
      });
      return toView(group, itemCount);
    });
  }

  archive(principal: Principal, taxGroupId: string, reason: string): Promise<TaxGroupView> {
    return this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      // Holds off menu items being given this group until the archive commits.
      await tx.$queryRaw`SELECT 1 AS locked FROM tax_groups WHERE id = ${taxGroupId}::uuid FOR UPDATE`;
      const existing = await this.find(tx, principal.restaurantId, taxGroupId);
      if (existing.archivedAt !== null) return toView(existing, 0);
      const itemCount = (await this.itemCounts(tx, [taxGroupId])).get(taxGroupId) ?? 0;
      if (itemCount > 0) {
        throw new AppError(
          409,
          'TAX_GROUP_IN_USE',
          `${String(itemCount)} menu items use this tax group. Move them to another tax group ` +
            'first, then archive it.',
          { itemCount },
        );
      }
      const group = await tx.taxGroup.update({
        where: { id: taxGroupId },
        data: { archivedAt: new Date() },
        include: WITH_COMPONENTS,
      });
      await this.record(tx, principal, 'TAX_GROUP_ARCHIVED', taxGroupId, {
        before: { archivedAt: null },
        after: { archivedAt: group.archivedAt?.toISOString() ?? null },
        reason,
      });
      await announceSetupChange(tx, principal.restaurantId, 'TAX_GROUPS', {
        type: 'tax_group',
        id: taxGroupId,
      });
      return toView(group, 0);
    });
  }

  private async find(
    tx: TransactionClient,
    restaurantId: string,
    taxGroupId: string,
  ): Promise<TaxGroupRow> {
    const group = await tx.taxGroup.findFirst({
      where: { id: taxGroupId, restaurantId },
      include: WITH_COMPONENTS,
    });
    if (group === null) throw notFound();
    return group;
  }

  /** Menu items (not archived) per tax group. */
  private async itemCounts(
    client: Pick<TransactionClient, 'item'>,
    taxGroupIds: readonly string[],
  ): Promise<Map<string, number>> {
    if (taxGroupIds.length === 0) return new Map();
    const rows = await client.item.groupBy({
      by: ['taxGroupId'],
      where: { taxGroupId: { in: [...taxGroupIds] }, archivedAt: null },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.taxGroupId, row._count._all]));
  }

  /** Two active groups with the same name would be ambiguous on the menu screens. */
  private async assertNameFree(
    tx: TransactionClient,
    restaurantId: string,
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    const clash = await tx.taxGroup.findFirst({
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
        'TAX_GROUP_NAME_TAKEN',
        `Another tax group is called "${name}". Choose another name.`,
      );
    }
  }

  private assertValid(id: string, request: TaxGroupRequest): void {
    const problems = validateTaxGroup({ id, name: request.name, components: request.components });
    if (problems.length > 0) {
      throw new AppError(422, 'TAX_GROUP_INVALID', problems.join('. '), { problems });
    }
  }

  private componentRows(restaurantId: string, request: TaxGroupRequest) {
    return request.components.map((component, index) => ({
      restaurantId,
      code: component.code,
      rateBp: component.rateBp,
      displayOrder: index + 1,
    }));
  }

  private async record(
    tx: TransactionClient,
    principal: Principal,
    action: string,
    taxGroupId: string,
    change: { before: unknown; after: unknown; reason: string | null },
  ): Promise<void> {
    await this.audit.record(tx, {
      action,
      entityType: 'tax_group',
      entityId: taxGroupId,
      actorId: principal.staffId,
      deviceId: principal.deviceId,
      restaurantId: principal.restaurantId,
      ...change,
    });
  }
}
