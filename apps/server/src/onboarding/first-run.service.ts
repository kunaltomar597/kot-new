import { Injectable } from '@nestjs/common';
import {
  type FirstRunRequest,
  type FirstRunResponse,
  type FirstRunStatus,
  settingDefinition,
} from '@rp/contracts';
import { isEasilyGuessedPin } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import { CredentialHasher } from '../auth/credential-hasher.js';
import { ADVISORY_LOCKS } from '../database/advisory-locks.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';

/** The built-in roles every restaurant starts with (BRD §4.2). */
const BUILT_IN_ROLES = [
  ['OWNER', 'Owner'],
  ['MANAGER', 'Manager'],
  ['CASHIER', 'Cashier'],
  ['WAITER', 'Waiter'],
  ['KITCHEN', 'Kitchen'],
] as const;

/** A new restaurant's PIN length: the setting's default (AUTH-001). */
function pinLength(): number {
  const value = settingDefinition('auth.pinLength')?.defaultValue;
  return typeof value === 'number' ? value : 4;
}

/** A new restaurant refuses easily guessed PINs unless the catalogue's default says not (PC-S5). */
function refuseEasyPins(): boolean {
  return settingDefinition('auth.refuseEasyPins')?.defaultValue !== false;
}

const closed = () =>
  new AppError(
    403,
    'FIRST_RUN_CLOSED',
    'This restaurant is already set up, or this is not the restaurant PC. Sign in instead.',
  );

/**
 * A fresh install's first step (ONB-001, P7-07b): on the restaurant PC itself and only while no
 * restaurant exists, create the restaurant with the built-in roles and a default invoice series,
 * and its Owner with a PIN. The Owner then pairs the PC (bootstrap code), signs in and sets a
 * password and authenticator (AUTH-006) as the set-up page asks.
 */
@Injectable()
export class FirstRunService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: CredentialHasher,
    private readonly audit: AuditService,
  ) {}

  async status(): Promise<FirstRunStatus> {
    return { needed: (await this.prisma.restaurant.count()) === 0, pinLength: pinLength() };
  }

  async complete(request: FirstRunRequest, loopback: boolean): Promise<FirstRunResponse> {
    if (!loopback) throw closed();
    if (request.ownerPin.length !== pinLength()) {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        `The PIN must have ${String(pinLength())} digits, as every PIN here.`,
      );
    }
    if (refuseEasyPins() && isEasilyGuessedPin(request.ownerPin)) {
      throw new AppError(
        422,
        'PIN_TOO_EASY',
        'That PIN is too easy to guess, like 1234, 1111, 1212 or a year. Choose another.',
      );
    }
    const pinHash = await this.hasher.hash(request.ownerPin);
    return this.prisma.transaction(async (tx) => {
      // Two first runs at once (two tabs): only one creates the restaurant.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${ADVISORY_LOCKS.pairingBootstrap})`;
      if ((await tx.restaurant.count()) > 0) throw closed();
      const restaurant = await tx.restaurant.create({
        data: { displayName: request.restaurantName },
      });
      const restaurantId = restaurant.id;
      let ownerRoleId = '';
      for (const [key, name] of BUILT_IN_ROLES) {
        const role = await tx.role.create({
          data: { restaurantId, key, name, baseRole: key },
        });
        if (key === 'OWNER') ownerRoleId = role.id;
      }
      await tx.invoiceSeries.create({
        data: { restaurantId, name: 'Tax invoice', prefix: 'INV', isDefault: true },
      });
      const owner = await tx.staff.create({
        data: { restaurantId, roleId: ownerRoleId, displayName: request.ownerName },
      });
      await tx.credential.create({
        data: { restaurantId, staffId: owner.id, kind: 'PIN', secretHash: pinHash },
      });
      await this.audit.record(tx, {
        action: 'RESTAURANT_CREATED',
        entityType: 'restaurant',
        entityId: restaurantId,
        actorId: owner.id,
        restaurantId,
        after: { displayName: request.restaurantName, owner: request.ownerName },
        reason: 'First run on the restaurant PC',
      });
      return { restaurantId, ownerId: owner.id };
    });
  }
}
