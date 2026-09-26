import { Injectable } from '@nestjs/common';
import {
  Address,
  BusinessHours,
  type RestaurantProfile,
  type UpdateRestaurantLegalRequest,
  type UpdateRestaurantProfileRequest,
} from '@rp/contracts';
import {
  businessDateOf,
  canonicalJson,
  cutoffChangeMovesBusinessDate,
  GST_STATE_CODES,
} from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import type { Prisma, Restaurant } from '../generated/prisma/client.js';
import { announceSetupChange, lockSetup } from './setup-changes.js';

/** The parts of the profile a manager changes (ONB-004 step 1). */
function profilePart(row: Restaurant) {
  return {
    displayName: row.displayName,
    phone: row.phone,
    email: row.email,
    businessHours: row.businessHours,
    logoPhotoId: row.logoPhotoId,
    businessDayCutoff: row.businessDayCutoff,
  };
}

/** The particulars printed on tax invoices (BILL-002), which only the Owner changes. */
function legalPart(row: Restaurant) {
  return {
    legalName: row.legalName,
    address: row.address,
    stateCode: row.stateCode,
    gstin: row.gstin,
    fssaiNumber: row.fssaiNumber,
  };
}

function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function toRestaurantProfile(row: Restaurant): RestaurantProfile {
  // Stored JSON is written through the contracts; anything else reads as not set.
  const address = Address.safeParse(row.address);
  const hours = BusinessHours.safeParse(row.businessHours);
  return {
    id: row.id,
    displayName: row.displayName,
    legalName: row.legalName,
    address: address.success ? address.data : null,
    stateCode: row.stateCode,
    stateName: row.stateCode === null ? null : (GST_STATE_CODES[row.stateCode] ?? null),
    gstin: row.gstin,
    fssaiNumber: row.fssaiNumber,
    contact: { phone: row.phone, email: row.email },
    businessHours: hours.success ? hours.data : [],
    logoPhotoId: row.logoPhotoId,
    timeZone: row.timeZone,
    businessDayCutoff: row.businessDayCutoff,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The restaurant profile (P1-01b, ONB-004 step 1). Managers keep the display name, contact,
 * opening hours, logo and business-day cut-off up to date; the invoice particulars (BILL-002) are
 * the Owner's, behind the second factor the route asks for (AUTH-006). Every change is audited
 * with before and after (AUD-001) and announced with `RestaurantChanged`.
 */
@Injectable()
export class RestaurantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(restaurantId: string): Promise<RestaurantProfile> {
    const row = await this.prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (row === null) throw AppError.notFound('The restaurant');
    return toRestaurantProfile(row);
  }

  updateProfile(
    principal: Principal,
    request: UpdateRestaurantProfileRequest,
  ): Promise<RestaurantProfile> {
    return this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      const before = await this.current(tx, principal.restaurantId);
      if (request.logoPhotoId !== null) {
        const photo = await tx.photo.findFirst({
          where: { id: request.logoPhotoId, restaurantId: principal.restaurantId },
          select: { id: true },
        });
        if (photo === null) {
          throw new AppError(
            422,
            'LOGO_PHOTO_NOT_FOUND',
            'That logo photo does not exist. Upload the logo first, then choose it.',
          );
        }
      }
      if (request.businessDayCutoff !== before.businessDayCutoff) {
        this.assertCutoffKeepsBusinessDate(before, request.businessDayCutoff);
      }
      const data = {
        displayName: request.displayName,
        phone: request.contact.phone,
        email: request.contact.email,
        businessHours: request.businessHours,
        logoPhotoId: request.logoPhotoId,
        businessDayCutoff: request.businessDayCutoff,
      } satisfies Prisma.RestaurantUncheckedUpdateInput;
      if (same(profilePart(before), data)) return toRestaurantProfile(before);

      const after = await tx.restaurant.update({ where: { id: before.id }, data });
      await this.record(tx, principal, 'RESTAURANT_PROFILE_CHANGED', {
        before: profilePart(before),
        after: profilePart(after),
        reason: request.reason,
      });
      await announceSetupChange(tx, before.id, 'PROFILE', { type: 'restaurant', id: before.id });
      return toRestaurantProfile(after);
    });
  }

  updateLegal(
    principal: Principal,
    request: UpdateRestaurantLegalRequest,
  ): Promise<RestaurantProfile> {
    return this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      const before = await this.current(tx, principal.restaurantId);
      const data = {
        legalName: request.legalName,
        address: request.address,
        stateCode: request.stateCode,
        gstin: request.gstin,
        fssaiNumber: request.fssaiNumber,
      } satisfies Prisma.RestaurantUncheckedUpdateInput;
      if (same(legalPart(before), data)) return toRestaurantProfile(before);

      const after = await tx.restaurant.update({ where: { id: before.id }, data });
      await this.record(tx, principal, 'RESTAURANT_LEGAL_CHANGED', {
        before: legalPart(before),
        after: legalPart(after),
        reason: request.reason,
      });
      await announceSetupChange(tx, before.id, 'LEGAL', { type: 'restaurant', id: before.id });
      return toRestaurantProfile(after);
    });
  }

  private async current(tx: TransactionClient, restaurantId: string): Promise<Restaurant> {
    const row = await tx.restaurant.findUnique({ where: { id: restaurantId } });
    if (row === null) throw AppError.notFound('The restaurant');
    return row;
  }

  /**
   * A new cut-off applies at once, so it must not move the business date records are being filed
   * under right now (BRD §9.4): 04:00 → 02:00 at 03:00 would start "tomorrow" mid-service.
   */
  private assertCutoffKeepsBusinessDate(restaurant: Restaurant, cutoff: string): void {
    const now = new Date();
    const { businessDayCutoff, timeZone } = restaurant;
    if (cutoffChangeMovesBusinessDate(now, businessDayCutoff, cutoff, timeZone)) {
      const current = businessDateOf(now, { cutoff: businessDayCutoff, timeZone });
      const next = businessDateOf(now, { cutoff, timeZone });
      throw new AppError(
        409,
        'CUTOFF_WOULD_MOVE_BUSINESS_DATE',
        'Changing the cut-off now would move the business date. Change it later in the day, ' +
          'after both the old and the new cut-off time.',
        { businessDate: current, businessDateWithNewCutoff: next },
      );
    }
  }

  private async record(
    tx: TransactionClient,
    principal: Principal,
    action: string,
    change: { before: unknown; after: unknown; reason: string | undefined },
  ): Promise<void> {
    await this.audit.record(tx, {
      action,
      entityType: 'restaurant',
      entityId: principal.restaurantId,
      actorId: principal.staffId,
      deviceId: principal.deviceId,
      restaurantId: principal.restaurantId,
      before: change.before,
      after: change.after,
      reason: change.reason ?? null,
    });
  }
}
