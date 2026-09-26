import { Injectable } from '@nestjs/common';
import type { CashMovementRequest, ShiftView } from '@rp/contracts';
import { cashVariance, countDenominations, expectedCash } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import { authErrors } from '../auth/auth-errors.js';
import type { Principal } from '../auth/principal.js';
import { currentBusinessDate, dbDate, isoDateOf } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import type { CashMovement, Shift } from '../generated/prisma/client.js';

type Client = PrismaService | TransactionClient;

function shiftNotFound(): AppError {
  return new AppError(404, 'SHIFT_NOT_FOUND', 'There is no such shift.');
}

function shiftClosed(): AppError {
  return new AppError(409, 'SHIFT_CLOSED', 'This shift is closed.');
}

/** Shift money is stored as BIGINT; amounts in one shift stay far below 2^53 paise. */
const paise = (value: bigint | null): number | null => (value === null ? null : Number(value));

/**
 * Cash shifts (P1-11a, BILL-013): a cashier opens a shift with a float, records cash taken in or
 * out with a reason, and closes it by counting the drawer; the expected cash and the variance are
 * kept (AUD-006). Cashiers act on their own shift, managers and the Owner on any (§4.2 OWN).
 */
@Injectable()
export class ShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async open(principal: Principal, openingFloat: number): Promise<ShiftView> {
    const id = await this.prisma.transaction(async (tx) => {
      // One open shift per person: the staff row serialises two opens at once.
      await tx.$queryRaw`SELECT 1 AS locked FROM staff WHERE id = ${principal.staffId}::uuid FOR UPDATE`;
      const existing = await this.openShiftOf(tx, principal);
      if (existing !== null) {
        throw new AppError(
          409,
          'SHIFT_ALREADY_OPEN',
          'You already have an open shift. Close it first.',
          {
            shiftId: existing.id,
          },
        );
      }
      const businessDate = await currentBusinessDate(tx, principal.restaurantId);
      const shift = await tx.shift.create({
        data: {
          id: newId(),
          restaurantId: principal.restaurantId,
          businessDate: dbDate(businessDate),
          staffId: principal.staffId,
          deviceId: principal.deviceId,
          openingFloat: BigInt(openingFloat),
        },
      });
      await this.record(tx, principal, 'SHIFT_OPENED', shift.id, null, { openingFloat }, null);
      return shift.id;
    });
    return this.view(this.prisma, principal.restaurantId, id);
  }

  async current(principal: Principal): Promise<ShiftView | null> {
    const shift = await this.openShiftOf(this.prisma, principal);
    return shift === null ? null : this.view(this.prisma, principal.restaurantId, shift.id);
  }

  /** The person's open shift, if any (cash payments go into it). */
  openShiftOf(client: Client, principal: Principal): Promise<Shift | null> {
    return client.shift.findFirst({
      where: { restaurantId: principal.restaurantId, staffId: principal.staffId, status: 'OPEN' },
    });
  }

  async moveCash(
    principal: Principal,
    shiftId: string,
    request: CashMovementRequest,
    ownOnly: boolean,
  ): Promise<ShiftView> {
    await this.prisma.transaction(async (tx) => {
      const shift = await this.lockedOpenShift(tx, principal, shiftId, ownOnly);
      const businessDate = await currentBusinessDate(tx, principal.restaurantId);
      const movement = await tx.cashMovement.create({
        data: {
          restaurantId: principal.restaurantId,
          businessDate: dbDate(businessDate),
          shiftId: shift.id,
          direction: request.direction,
          amount: request.amount,
          reason: request.reason,
          staffId: principal.staffId,
        },
      });
      await this.record(
        tx,
        principal,
        request.direction === 'IN' ? 'CASH_IN' : 'CASH_OUT',
        shift.id,
        null,
        { movementId: movement.id, amount: request.amount },
        request.reason,
      );
    });
    return this.view(this.prisma, principal.restaurantId, shiftId);
  }

  async close(
    principal: Principal,
    shiftId: string,
    counted: { countedCash: number | null; denominations: Record<string, number> | null },
    ownOnly: boolean,
  ): Promise<ShiftView> {
    await this.prisma.transaction(async (tx) => {
      const shift = await this.lockedOpenShift(tx, principal, shiftId, ownOnly);
      const totals = await this.totals(tx, shift);
      const expected = expectedCash(totals);
      const countedCash =
        counted.denominations === null
          ? (counted.countedCash ?? 0)
          : countDenominations(counted.denominations);
      const variance = cashVariance(countedCash, expected);
      await tx.shift.update({
        where: { id: shift.id },
        data: {
          status: 'CLOSED',
          closedAt: new Date(),
          expectedCash: BigInt(expected),
          countedCash: BigInt(countedCash),
          variance: BigInt(variance),
          ...(counted.denominations !== null && { denominations: counted.denominations }),
        },
      });
      await this.record(
        tx,
        principal,
        'SHIFT_CLOSED',
        shift.id,
        { status: 'OPEN' },
        { status: 'CLOSED', expectedCash: expected, countedCash, variance },
        null,
      );
    });
    return this.view(this.prisma, principal.restaurantId, shiftId);
  }

  async view(client: Client, restaurantId: string, shiftId: string): Promise<ShiftView> {
    const shift = await client.shift.findFirst({
      where: { id: shiftId, restaurantId },
      include: { cashMovements: { orderBy: { createdAt: 'asc' } } },
    });
    if (shift === null) throw shiftNotFound();
    const totals = await this.totals(client, shift, shift.cashMovements);
    return {
      id: shift.id,
      staffId: shift.staffId,
      status: shift.status,
      businessDate: isoDateOf(shift.businessDate),
      openedAt: shift.openedAt.toISOString(),
      closedAt: shift.closedAt?.toISOString() ?? null,
      openingFloat: totals.openingFloat,
      cashPayments: totals.cashPayments,
      cashIn: totals.cashIn,
      cashOut: totals.cashOut,
      expectedCash: paise(shift.expectedCash) ?? expectedCash(totals),
      countedCash: paise(shift.countedCash),
      variance: paise(shift.variance),
      denominations: (shift.denominations ?? null) as Record<string, number> | null,
      movements: shift.cashMovements.map((movement) => ({
        id: movement.id,
        direction: movement.direction,
        amount: movement.amount,
        reason: movement.reason,
        staffId: movement.staffId,
        createdAt: movement.createdAt.toISOString(),
      })),
    };
  }

  private async totals(client: Client, shift: Shift, movements?: CashMovement[]) {
    const [cash, cashMovements] = await Promise.all([
      client.payment.aggregate({
        where: { shiftId: shift.id, mode: 'CASH', status: 'CAPTURED' },
        _sum: { amount: true },
      }),
      movements ?? client.cashMovement.findMany({ where: { shiftId: shift.id } }),
    ]);
    const moved = (direction: 'IN' | 'OUT') =>
      cashMovements
        .filter((movement) => movement.direction === direction)
        .reduce((total, movement) => total + movement.amount, 0);
    return {
      openingFloat: Number(shift.openingFloat),
      cashPayments: cash._sum.amount ?? 0,
      cashIn: moved('IN'),
      cashOut: moved('OUT'),
    };
  }

  private async lockedOpenShift(
    tx: TransactionClient,
    principal: Principal,
    shiftId: string,
    ownOnly: boolean,
  ): Promise<Shift> {
    await tx.$queryRaw`SELECT 1 AS locked FROM shifts WHERE id = ${shiftId}::uuid FOR UPDATE`;
    const shift = await tx.shift.findFirst({
      where: { id: shiftId, restaurantId: principal.restaurantId },
    });
    if (shift === null) throw shiftNotFound();
    // §4.2 OWN: a cashier handles cash for their own shift only.
    if (ownOnly && shift.staffId !== principal.staffId) throw authErrors.forbidden();
    if (shift.status !== 'OPEN') throw shiftClosed();
    return shift;
  }

  private async record(
    tx: TransactionClient,
    principal: Principal,
    action: string,
    shiftId: string,
    before: unknown,
    after: unknown,
    reason: string | null,
  ): Promise<void> {
    await this.audit.record(tx, {
      action,
      entityType: 'shift',
      entityId: shiftId,
      actorId: principal.staffId,
      deviceId: principal.deviceId,
      restaurantId: principal.restaurantId,
      before,
      after,
      reason,
    });
  }
}
