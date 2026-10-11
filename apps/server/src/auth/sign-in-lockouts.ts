import { Injectable } from '@nestjs/common';
import type { TransactionClient } from '../database/prisma.service.js';

/** A person's sign-in that locked after wrong secrets, or a device that stopped taking them. */
export type SignInLockout =
  | {
      readonly kind: 'PERSON';
      readonly restaurantId: string;
      readonly staffId: string;
      readonly staffName: string;
      /** Where the last wrong secret was typed. */
      readonly deviceId: string;
      readonly deviceName: string;
      readonly method: string;
      readonly lockedUntil: Date;
    }
  | {
      readonly kind: 'DEVICE';
      readonly restaurantId: string;
      readonly deviceId: string;
      readonly deviceName: string;
      readonly lockedUntil: Date;
    };

/** A lock lifted before its time: a person's sign-in, or a device's PINs. */
export type SignInUnlock =
  | { readonly kind: 'PERSON'; readonly restaurantId: string; readonly staffId: string }
  | { readonly kind: 'DEVICE'; readonly restaurantId: string; readonly deviceId: string };

export interface SignInLockoutListener {
  locked(tx: TransactionClient, lockout: SignInLockout): Promise<void>;
  unlocked(tx: TransactionClient, unlock: SignInUnlock): Promise<void>;
}

/**
 * Where lockouts are told, in the transaction that locks or unlocks (PC-S5, PC-D2): the
 * notification engine alerts the managers and the Owner, and clears the alert when a manager lifts
 * the lock. A registry, like the presence registry, because the engine's module builds on this one.
 */
@Injectable()
export class SignInLockouts {
  private readonly listeners = new Set<SignInLockoutListener>();

  add(listener: SignInLockoutListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async locked(tx: TransactionClient, lockout: SignInLockout): Promise<void> {
    for (const listener of this.listeners) await listener.locked(tx, lockout);
  }

  async unlocked(tx: TransactionClient, unlock: SignInUnlock): Promise<void> {
    for (const listener of this.listeners) await listener.unlocked(tx, unlock);
  }
}
