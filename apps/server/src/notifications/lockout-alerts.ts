import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { TransactionClient } from '../database/prisma.service.js';
import { type SignInLockout, SignInLockouts, type SignInUnlock } from '../auth/sign-in-lockouts.js';
import { NotificationsService } from './notifications.service.js';

const dedupeKeyOf = (target: SignInLockout | SignInUnlock): string =>
  target.kind === 'PERSON'
    ? `lockout:staff:${target.staffId}`
    : `lockout:device:${target.deviceId}`;

/**
 * Tells the managers and the Owner of every lockout (PC-S5, PC-D2): a person's login locked after
 * wrong PINs or passwords, or a device that stopped taking them. One alert per person or device
 * while it is open; it clears when a manager lifts the lock.
 */
@Injectable()
export class LockoutAlerts implements OnModuleInit {
  constructor(
    private readonly lockouts: SignInLockouts,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.lockouts.add({
      locked: (tx, lockout) => this.locked(tx, lockout),
      unlocked: (tx, unlock) => this.unlocked(tx, unlock),
    });
  }

  async locked(tx: TransactionClient, lockout: SignInLockout): Promise<void> {
    await this.notifications.raise(tx, {
      restaurantId: lockout.restaurantId,
      type: 'SIGN_IN_LOCKED',
      dedupeKey: dedupeKeyOf(lockout),
      payload:
        lockout.kind === 'PERSON'
          ? {
              scope: 'PERSON',
              staffId: lockout.staffId,
              staffName: lockout.staffName,
              deviceId: lockout.deviceId,
              deviceName: lockout.deviceName,
              method: lockout.method,
              lockedUntil: lockout.lockedUntil.toISOString(),
            }
          : {
              scope: 'DEVICE',
              deviceId: lockout.deviceId,
              deviceName: lockout.deviceName,
              lockedUntil: lockout.lockedUntil.toISOString(),
            },
    });
  }

  async unlocked(tx: TransactionClient, unlock: SignInUnlock): Promise<void> {
    await this.notifications.clear(tx, {
      restaurantId: unlock.restaurantId,
      dedupeKey: dedupeKeyOf(unlock),
    });
  }
}
