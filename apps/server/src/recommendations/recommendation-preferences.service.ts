import { Injectable } from '@nestjs/common';
import type {
  RecommendationPreferenceListResponse,
  RecommendationPreferenceRequest,
  RecommendationPreferenceView,
} from '@rp/contracts';
import type { ItemPreferenceDef } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { newId } from '../common/ids.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import type { RecommendationPreference } from '../generated/prisma/client.js';

const errors = {
  itemNotFound: () => new AppError(404, 'ITEM_NOT_FOUND', 'There is no such active item.'),
};

function preferenceView(row: RecommendationPreference): RecommendationPreferenceView {
  return {
    itemId: row.itemId,
    preference: row.preference,
    label: row.label,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The manager's pinned, boosted and blocked dishes (REC-009, P4-03c), changed on the dashboard's
 * Recommendations page. A change applies to the next suggestions at once, without publishing the
 * menu. Each dish has one row, changed in place and back to NORMAL rather than deleted; every
 * change is audited with before, after and the reason (AUD-001).
 */
@Injectable()
export class RecommendationPreferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The dishes not archived that are pinned, boosted or blocked, the latest change first. */
  async list(restaurantId: string): Promise<RecommendationPreferenceListResponse> {
    const rows = await this.prisma.recommendationPreference.findMany({
      where: { restaurantId, preference: { not: 'NORMAL' } },
      orderBy: [{ updatedAt: 'desc' }, { itemId: 'asc' }],
    });
    const active = await this.prisma.item.findMany({
      where: { restaurantId, id: { in: rows.map((row) => row.itemId) }, archivedAt: null },
      select: { id: true },
    });
    const shown = new Set(active.map((item) => item.id));
    return { preferences: rows.filter((row) => shown.has(row.itemId)).map(preferenceView) };
  }

  /** What `recommend` takes: every dish that is not NORMAL (an archived one is never served). */
  async active(restaurantId: string): Promise<ItemPreferenceDef[]> {
    const rows = await this.prisma.recommendationPreference.findMany({
      where: { restaurantId, preference: { not: 'NORMAL' } },
      select: { itemId: true, preference: true, label: true },
    });
    return rows.flatMap(({ itemId, preference, label }) =>
      preference === 'NORMAL' ? [] : [{ itemId, preference, label }],
    );
  }

  set(
    principal: Principal,
    itemId: string,
    request: RecommendationPreferenceRequest,
  ): Promise<RecommendationPreferenceView> {
    const { restaurantId } = principal;
    return this.prisma.transaction(async (tx) => {
      const item = await tx.item.findFirst({
        where: { id: itemId, restaurantId, archivedAt: null },
        select: { id: true },
      });
      if (item === null) throw errors.itemNotFound();
      // One row per dish: made NORMAL the first time, then locked so that two managers changing
      // the same dish at once are audited one after the other.
      await tx.$executeRaw`
        INSERT INTO recommendation_preferences (id, restaurant_id, item_id, preference)
        VALUES (${newId()}::uuid, ${restaurantId}::uuid, ${itemId}::uuid, 'NORMAL')
        ON CONFLICT (restaurant_id, item_id) DO NOTHING`;
      await tx.$queryRaw`
        SELECT 1 AS locked FROM recommendation_preferences
        WHERE restaurant_id = ${restaurantId}::uuid AND item_id = ${itemId}::uuid FOR UPDATE`;
      const existing = await tx.recommendationPreference.findUniqueOrThrow({
        where: { restaurantId_itemId: { restaurantId, itemId } },
      });
      // Nothing to write or audit when the dish stays as it is.
      if (existing.preference === request.preference && existing.label === request.label) {
        return preferenceView(existing);
      }
      const row = await tx.recommendationPreference.update({
        where: { id: existing.id },
        data: {
          preference: request.preference,
          label: request.label,
          updatedById: principal.staffId,
        },
      });
      await this.audit.record(tx, {
        action: 'RECOMMENDATION_PREFERENCE_CHANGED',
        entityType: 'menu_item',
        entityId: itemId,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId,
        before: { preference: existing.preference, label: existing.label },
        after: { preference: row.preference, label: row.label },
        reason: request.reason ?? null,
      });
      return preferenceView(row);
    });
  }
}
