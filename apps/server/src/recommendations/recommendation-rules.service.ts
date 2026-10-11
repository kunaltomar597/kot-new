import { Injectable } from '@nestjs/common';
import type {
  RecommendationRuleListResponse,
  RecommendationRuleRequest,
  RecommendationRuleView,
  RecommendationTarget,
} from '@rp/contracts';
import { canonicalJson, type RecommendationRuleDef } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { dbDate, isoDateOf } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import type { RecommendationRule } from '../generated/prisma/client.js';

const errors = {
  notFound: () =>
    new AppError(404, 'RECOMMENDATION_RULE_NOT_FOUND', 'There is no such recommendation rule.'),
  targetInvalid: (details: { itemIds: string[]; categoryIds: string[] }) =>
    new AppError(
      422,
      'RECOMMENDATION_TARGET_INVALID',
      'A rule can only name items and categories that are on the menu and not archived.',
      details,
    ),
};

function targetOf(itemId: string | null, categoryId: string | null): RecommendationTarget {
  return itemId !== null
    ? { kind: 'ITEM', itemId }
    : { kind: 'CATEGORY', categoryId: categoryId ?? '' };
}

function ruleView(row: RecommendationRule): RecommendationRuleView {
  return {
    id: row.id,
    when: targetOf(row.whenItemId, row.whenCategoryId),
    suggest: targetOf(row.suggestItemId, row.suggestCategoryId),
    priority: row.priority,
    channels: row.channels,
    timeWindow:
      row.windowStart === null || row.windowEnd === null
        ? null
        : { start: row.windowStart, end: row.windowEnd },
    activeFrom: row.activeFrom === null ? null : isoDateOf(row.activeFrom),
    activeUntil: row.activeUntil === null ? null : isoDateOf(row.activeUntil),
    label: row.label,
    active: row.active,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A rule as `@rp/domain` `recommend` takes it. */
export function ruleDef(row: RecommendationRule): RecommendationRuleDef {
  const view = ruleView(row);
  return {
    id: view.id,
    priority: view.priority,
    when: view.when,
    suggest: view.suggest,
    channels: view.channels,
    timeWindow: view.timeWindow,
    activeFrom: view.activeFrom,
    activeUntil: view.activeUntil,
    label: view.label,
  };
}

/** What a rule does, to tell whether a change changes anything. */
function settingsOf(rule: RecommendationRuleView | RecommendationRuleRequest): string {
  return canonicalJson({
    when: rule.when,
    suggest: rule.suggest,
    priority: rule.priority,
    channels: rule.channels,
    timeWindow: rule.timeWindow,
    activeFrom: rule.activeFrom,
    activeUntil: rule.activeUntil,
    label: rule.label,
    active: rule.active,
  });
}

/** The columns a request sets. */
function columnsOf(request: RecommendationRuleRequest) {
  return {
    whenItemId: request.when.kind === 'ITEM' ? request.when.itemId : null,
    whenCategoryId: request.when.kind === 'CATEGORY' ? request.when.categoryId : null,
    suggestItemId: request.suggest.kind === 'ITEM' ? request.suggest.itemId : null,
    suggestCategoryId: request.suggest.kind === 'CATEGORY' ? request.suggest.categoryId : null,
    priority: request.priority,
    channels: request.channels,
    windowStart: request.timeWindow?.start ?? null,
    windowEnd: request.timeWindow?.end ?? null,
    activeFrom: request.activeFrom === null ? null : dbDate(request.activeFrom),
    activeUntil: request.activeUntil === null ? null : dbDate(request.activeUntil),
    label: request.label,
    active: request.active,
  };
}

/**
 * Manual recommendation rules (REC-002): "if the order contains X, suggest Y", managed on the
 * dashboard (the editor is P4-03). Every change is audited with before and after (AUD-001); a rule
 * is archived, never deleted, so the events that name it keep their meaning (REC-008).
 */
@Injectable()
export class RecommendationRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(restaurantId: string): Promise<RecommendationRuleListResponse> {
    const rows = await this.prisma.recommendationRule.findMany({
      where: { restaurantId, archivedAt: null },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    return { rules: rows.map(ruleView) };
  }

  /** The rules `recommend` applies: not archived and not paused. */
  async active(restaurantId: string): Promise<RecommendationRuleDef[]> {
    const rows = await this.prisma.recommendationRule.findMany({
      where: { restaurantId, archivedAt: null, active: true },
    });
    return rows.map(ruleDef);
  }

  create(
    principal: Principal,
    request: RecommendationRuleRequest,
  ): Promise<RecommendationRuleView> {
    return this.prisma.transaction(async (tx) => {
      await this.checkTargets(tx, principal.restaurantId, request);
      const row = await tx.recommendationRule.create({
        data: {
          id: newId(),
          restaurantId: principal.restaurantId,
          createdById: principal.staffId,
          ...columnsOf(request),
        },
      });
      const view = ruleView(row);
      await this.record(tx, principal, 'RECOMMENDATION_RULE_CREATED', row.id, null, view);
      return view;
    });
  }

  update(
    principal: Principal,
    ruleId: string,
    request: RecommendationRuleRequest,
  ): Promise<RecommendationRuleView> {
    return this.prisma.transaction(async (tx) => {
      const existing = await this.lock(tx, principal.restaurantId, ruleId);
      // An archived rule is gone for the editor: it cannot come back by a change.
      if (existing?.archivedAt !== null) throw errors.notFound();
      await this.checkTargets(tx, principal.restaurantId, request);
      const before = ruleView(existing);
      // Nothing to write or audit when the rule stays as it is.
      if (settingsOf(before) === settingsOf(request)) return before;
      const row = await tx.recommendationRule.update({
        where: { id: ruleId },
        data: columnsOf(request),
      });
      const after = ruleView(row);
      await this.record(tx, principal, 'RECOMMENDATION_RULE_CHANGED', ruleId, before, after);
      return after;
    });
  }

  archive(principal: Principal, ruleId: string, reason: string): Promise<RecommendationRuleView> {
    return this.prisma.transaction(async (tx) => {
      const existing = await this.lock(tx, principal.restaurantId, ruleId);
      if (existing === null) throw errors.notFound();
      if (existing.archivedAt !== null) return ruleView(existing);
      const row = await tx.recommendationRule.update({
        where: { id: ruleId },
        data: { archivedAt: new Date() },
      });
      const after = ruleView(row);
      await this.record(
        tx,
        principal,
        'RECOMMENDATION_RULE_ARCHIVED',
        ruleId,
        ruleView(existing),
        after,
        reason,
      );
      return after;
    });
  }

  /** Both sides must be items or categories of this restaurant that are not archived. */
  private async checkTargets(
    tx: TransactionClient,
    restaurantId: string,
    request: RecommendationRuleRequest,
  ): Promise<void> {
    const targets = [request.when, request.suggest];
    const itemIds = [
      ...new Set(targets.flatMap((target) => (target.kind === 'ITEM' ? [target.itemId] : []))),
    ];
    const categoryIds = [
      ...new Set(
        targets.flatMap((target) => (target.kind === 'CATEGORY' ? [target.categoryId] : [])),
      ),
    ];
    const [items, categories] = await Promise.all([
      tx.item.findMany({
        where: { restaurantId, id: { in: itemIds }, archivedAt: null },
        select: { id: true },
      }),
      tx.category.findMany({
        where: { restaurantId, id: { in: categoryIds }, archivedAt: null },
        select: { id: true },
      }),
    ]);
    const foundItems = new Set(items.map((item) => item.id));
    const foundCategories = new Set(categories.map((category) => category.id));
    const missing = {
      itemIds: itemIds.filter((id) => !foundItems.has(id)),
      categoryIds: categoryIds.filter((id) => !foundCategories.has(id)),
    };
    if (missing.itemIds.length > 0 || missing.categoryIds.length > 0) {
      throw errors.targetInvalid(missing);
    }
  }

  private async lock(
    tx: TransactionClient,
    restaurantId: string,
    ruleId: string,
  ): Promise<RecommendationRule | null> {
    await tx.$queryRaw`SELECT 1 AS locked FROM recommendation_rules WHERE id = ${ruleId}::uuid FOR UPDATE`;
    return tx.recommendationRule.findFirst({ where: { id: ruleId, restaurantId } });
  }

  private async record(
    tx: TransactionClient,
    principal: Principal,
    action: string,
    ruleId: string,
    before: unknown,
    after: unknown,
    reason?: string,
  ): Promise<void> {
    await this.audit.record(tx, {
      action,
      entityType: 'recommendation_rule',
      entityId: ruleId,
      actorId: principal.staffId,
      deviceId: principal.deviceId,
      restaurantId: principal.restaurantId,
      before,
      after,
      reason: reason ?? null,
    });
  }
}
