import { Injectable } from '@nestjs/common';
import type {
  CreateStaffRequest,
  StaffListResponse,
  StaffView,
  UpdateStaffRequest,
} from '@rp/contracts';
import {
  type AssignableRole,
  decideStaffChange,
  grantFor,
  isValidPin,
  type Role,
  type StaffChange,
  type StaffRefusal,
  type StaffTarget,
} from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import { authErrors } from '../auth/auth-errors.js';
import { type AuthSettings, AuthSettingsService } from '../auth/auth-settings.js';
import { CredentialHasher } from '../auth/credential-hasher.js';
import type { Principal } from '../auth/principal.js';
import { hasFreshStepUp } from '../auth/step-up.js';
import { currentBusinessDate, dbDate } from '../common/business-dates.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { PagerBroker } from '../pagers/pager-broker.js';
import { announceSetupChange, lockSetup } from '../restaurant/setup-changes.js';

const STAFF_INCLUDE = {
  role: { select: { baseRole: true } },
  credentials: { select: { kind: true, lockedUntil: true } },
} as const;

interface StaffRow {
  readonly id: string;
  readonly displayName: string;
  readonly active: boolean;
  readonly phone: string | null;
  readonly email: string | null;
  readonly photoId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly role: { readonly baseRole: Role };
  readonly credentials: readonly { readonly kind: string; readonly lockedUntil: Date | null }[];
}

/** Names of the built-in roles, created with the first person given each role. */
const BUILT_IN_ROLE_NAMES: Readonly<Record<AssignableRole, string>> = {
  MANAGER: 'Manager',
  CASHIER: 'Cashier',
  WAITER: 'Waiter',
  KITCHEN: 'Kitchen',
};

function view(person: StaffRow, now: Date): StaffView {
  const locks = person.credentials
    .map((credential) => credential.lockedUntil)
    .filter((until): until is Date => until !== null && until > now)
    .sort((a, b) => b.getTime() - a.getTime());
  return {
    id: person.id,
    displayName: person.displayName,
    role: person.role.baseRole,
    active: person.active,
    phone: person.phone,
    email: person.email,
    photoId: person.photoId,
    hasPin: person.credentials.some((credential) => credential.kind === 'PIN'),
    lockedUntil: locks[0]?.toISOString() ?? null,
    createdAt: person.createdAt.toISOString(),
    updatedAt: person.updatedAt.toISOString(),
  };
}

const staffErrors = {
  notFound: () => new AppError(404, 'STAFF_NOT_FOUND', 'There is no such person.'),
  pinLength: (length: number) =>
    new AppError(422, 'PIN_LENGTH', `The PIN must have exactly ${String(length)} digits.`, {
      pinLength: length,
    }),
  refused: (reason: StaffRefusal): AppError => {
    switch (reason) {
      case 'DENIED':
        return authErrors.forbidden();
      case 'OWNER_ONLY':
        return authErrors.ownerOnly();
      case 'SECOND_FACTOR_REQUIRED':
        return authErrors.secondFactorRequired();
      case 'OWNER_RECORD':
        return new AppError(
          422,
          'OWNER_RECORD',
          'The Owner always stays active and keeps the Owner role.',
        );
      case 'OWN_RECORD':
        return new AppError(
          422,
          'OWN_RECORD',
          'You cannot deactivate yourself or change your own role. Ask the Owner.',
        );
      case 'ALREADY_ACTIVE':
        return new AppError(409, 'STAFF_ALREADY_ACTIVE', 'This person is already active.');
      case 'ALREADY_INACTIVE':
        return new AppError(409, 'STAFF_ALREADY_INACTIVE', 'This person is already deactivated.');
    }
  },
};

/**
 * Staff administration (P4-02a, MGR-004): adding people, their roles and PINs, deactivating and
 * reactivating them; never deleting (AUD-004). Who may change whom is `decideStaffChange`
 * (`@rp/domain`), including the Owner's fresh second factor for creating or removing managers
 * (AUTH-006). PINs are hashed with the pepper and never stored, logged or audited (AUTH-002).
 * Every change is audited in its own transaction and announced as `RestaurantChanged` `STAFF`, so
 * login tiles and staff lists are read again.
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: CredentialHasher,
    private readonly settings: AuthSettingsService,
    private readonly audit: AuditService,
    private readonly pagers: PagerBroker,
  ) {}

  /** Everyone not archived, active first, by name (MGR-004). */
  async list(principal: Principal): Promise<StaffListResponse> {
    const [staff, settings] = await Promise.all([
      this.prisma.staff.findMany({
        where: { restaurantId: principal.restaurantId, archivedAt: null },
        include: STAFF_INCLUDE,
        orderBy: [{ active: 'desc' }, { displayName: 'asc' }],
      }),
      this.settings.get(principal.restaurantId),
    ]);
    const now = new Date();
    return { staff: staff.map((person) => view(person, now)), pinLength: settings.pinLength };
  }

  async create(principal: Principal, request: CreateStaffRequest): Promise<StaffView> {
    const settings = await this.settings.get(principal.restaurantId);
    this.require(principal, settings, null, { kind: 'CREATE', role: request.role });
    this.requirePinLength(request.pin, settings);
    const secretHash = await this.hasher.hash(request.pin);
    const { restaurantId } = principal;
    const person = await this.prisma.transaction(async (tx) => {
      const role = await this.builtInRole(tx, restaurantId, request.role);
      const created = await tx.staff.create({
        data: {
          restaurantId,
          roleId: role.id,
          displayName: request.displayName,
          phone: request.phone ?? null,
          email: request.email ?? null,
          credentials: { create: { restaurantId, kind: 'PIN', secretHash } },
        },
        include: STAFF_INCLUDE,
      });
      await this.record(tx, principal, 'STAFF_CREATED', created.id, null, {
        displayName: created.displayName,
        role: request.role,
        hasPhone: created.phone !== null,
        hasEmail: created.email !== null,
      });
      await announceSetupChange(tx, restaurantId, 'STAFF', { type: 'staff', id: created.id });
      return created;
    });
    return view(person, new Date());
  }

  /**
   * Name, contact and role. A new role applies to the person's next request (AUTH-010); someone
   * who no longer takes orders leaves today's sections.
   */
  async update(
    principal: Principal,
    staffId: string,
    request: UpdateStaffRequest,
  ): Promise<StaffView> {
    const settings = await this.settings.get(principal.restaurantId);
    const { restaurantId } = principal;
    const person = await this.prisma.transaction(async (tx) => {
      const target = await this.lockedTarget(tx, restaurantId, staffId);
      const newRole =
        request.role !== undefined && request.role !== target.role.baseRole
          ? request.role
          : undefined;
      const details = (['displayName', 'phone', 'email'] as const).filter(
        (field) => request[field] !== undefined && request[field] !== target[field],
      );
      if (details.length > 0) this.require(principal, settings, target, { kind: 'EDIT' });
      if (newRole !== undefined) {
        this.require(principal, settings, target, { kind: 'CHANGE_ROLE', role: newRole });
      }
      if (details.length === 0 && newRole === undefined) return target;

      const updated = await tx.staff.update({
        where: { id: target.id },
        data: {
          ...(request.displayName !== undefined && { displayName: request.displayName }),
          ...(request.phone !== undefined && { phone: request.phone }),
          ...(request.email !== undefined && { email: request.email }),
          ...(newRole !== undefined && {
            roleId: (await this.builtInRole(tx, restaurantId, newRole)).id,
          }),
        },
        include: STAFF_INCLUDE,
      });
      const leftSections =
        newRole !== undefined && grantFor(newRole, 'ORDER_CREATE') === 'DENY'
          ? await this.takeOffSections(tx, restaurantId, target.id)
          : 0;
      // Contact details are personal data: the audit says they changed, not what they are.
      await this.record(
        tx,
        principal,
        'STAFF_UPDATED',
        target.id,
        {
          ...(details.includes('displayName') && { displayName: target.displayName }),
          ...(newRole !== undefined && { role: target.role.baseRole }),
        },
        {
          ...(details.includes('displayName') && { displayName: updated.displayName }),
          ...(newRole !== undefined && { role: newRole }),
          changed: [...details, ...(newRole === undefined ? [] : ['role'])],
          ...(leftSections > 0 && { leftSections }),
        },
      );
      await announceSetupChange(tx, restaurantId, 'STAFF', { type: 'staff', id: target.id });
      return updated;
    });
    return view(person, new Date());
  }

  /**
   * Deactivates, never deletes (MGR-004): their sessions end at once and their live connections
   * close at the next check (within 5 s, AUTH-008); their pager and waiter phone are taken back
   * and they leave today's sections, so their alerts go to others.
   */
  async deactivate(principal: Principal, staffId: string, reason: string): Promise<StaffView> {
    const settings = await this.settings.get(principal.restaurantId);
    const { restaurantId } = principal;
    const now = new Date();
    const { person, pagerIds } = await this.prisma.transaction(async (tx) => {
      const target = await this.lockedTarget(tx, restaurantId, staffId);
      this.require(principal, settings, target, { kind: 'DEACTIVATE' });
      const updated = await tx.staff.update({
        where: { id: target.id },
        data: { active: false, onBreakSince: null },
        include: STAFF_INCLUDE,
      });
      const sessions = await tx.session.updateMany({
        where: { staffId: target.id, revokedAt: null },
        data: { revokedAt: now, revokeReason: 'STAFF_DEACTIVATED' },
      });
      const pagers = await tx.device.findMany({
        where: { restaurantId, staffId: target.id, type: 'PAGER' },
        select: { id: true },
      });
      const devices = await tx.device.updateMany({
        where: { restaurantId, staffId: target.id, type: { in: ['PAGER', 'WAITER_PHONE'] } },
        data: { staffId: null },
      });
      const leftSections = await this.takeOffSections(tx, restaurantId, target.id);
      await this.record(
        tx,
        principal,
        'STAFF_DEACTIVATED',
        target.id,
        { active: true },
        {
          active: false,
          sessionsEnded: sessions.count,
          pagersTakenBack: pagers.map((pager) => pager.id),
          devicesReleased: devices.count,
          leftSections,
        },
        reason,
      );
      await announceSetupChange(tx, restaurantId, 'STAFF', { type: 'staff', id: target.id });
      return { person: updated, pagerIds: pagers.map((pager) => pager.id) };
    });
    // A connected pager learns at once that nobody wears it (PGR-014).
    for (const pagerId of pagerIds) await this.pagers.reassigned(pagerId, null);
    return view(person, now);
  }

  async reactivate(principal: Principal, staffId: string): Promise<StaffView> {
    const settings = await this.settings.get(principal.restaurantId);
    const { restaurantId } = principal;
    const person = await this.prisma.transaction(async (tx) => {
      const target = await this.lockedTarget(tx, restaurantId, staffId);
      this.require(principal, settings, target, { kind: 'REACTIVATE' });
      const updated = await tx.staff.update({
        where: { id: target.id },
        data: { active: true },
        include: STAFF_INCLUDE,
      });
      await this.record(
        tx,
        principal,
        'STAFF_REACTIVATED',
        target.id,
        { active: false },
        {
          active: true,
        },
      );
      await announceSetupChange(tx, restaurantId, 'STAFF', { type: 'staff', id: target.id });
      return updated;
    });
    return view(person, new Date());
  }

  /**
   * Sets or resets a PIN (AUTH-001, AUTH-002) and lifts a lockout (AUTH-003). The person's other
   * sessions end, in case the old PIN was known to someone else.
   */
  async setPin(principal: Principal, staffId: string, pin: string): Promise<void> {
    const settings = await this.settings.get(principal.restaurantId);
    this.requirePinLength(pin, settings);
    const secretHash = await this.hasher.hash(pin);
    const { restaurantId } = principal;
    const now = new Date();
    await this.prisma.transaction(async (tx) => {
      const target = await this.lockedTarget(tx, restaurantId, staffId);
      this.require(principal, settings, target, { kind: 'SET_PIN' });
      const had = target.credentials.find((credential) => credential.kind === 'PIN');
      await tx.credential.upsert({
        where: { staffId_kind: { staffId: target.id, kind: 'PIN' } },
        create: { restaurantId, staffId: target.id, kind: 'PIN', secretHash },
        update: {
          secretHash,
          rotatedAt: now,
          failedAttempts: 0,
          failureWindowStartedAt: null,
          lockedUntil: null,
        },
      });
      const sessions = await tx.session.updateMany({
        where: { staffId: target.id, revokedAt: null, id: { not: principal.sessionId } },
        data: { revokedAt: now, revokeReason: 'PIN_CHANGED' },
      });
      await this.record(tx, principal, 'STAFF_PIN_SET', target.id, null, {
        firstPin: had === undefined,
        lockLifted:
          had?.lockedUntil !== undefined && had.lockedUntil !== null && had.lockedUntil > now,
        sessionsEnded: sessions.count,
      });
      // Only people with a PIN have a login tile.
      if (had === undefined) {
        await announceSetupChange(tx, restaurantId, 'STAFF', { type: 'staff', id: target.id });
      }
    });
  }

  private require(
    principal: Principal,
    settings: AuthSettings,
    target: StaffRow | null,
    change: StaffChange,
  ): void {
    const actor = {
      staffId: principal.staffId,
      role: principal.role,
      secondFactorFresh: hasFreshStepUp(principal, settings.stepUpMinutes),
    };
    const subject: StaffTarget | null =
      target === null
        ? null
        : { staffId: target.id, role: target.role.baseRole, active: target.active };
    const decision = decideStaffChange(actor, subject, change);
    if (!decision.allowed) throw staffErrors.refused(decision.reason);
  }

  private requirePinLength(pin: string, settings: AuthSettings): void {
    if (!isValidPin(pin, settings.pinLength)) throw staffErrors.pinLength(settings.pinLength);
  }

  /** The person, locked for the rest of the transaction so two changes cannot interleave. */
  private async lockedTarget(
    tx: TransactionClient,
    restaurantId: string,
    staffId: string,
  ): Promise<StaffRow> {
    await tx.$queryRaw`SELECT 1 AS locked FROM staff WHERE id = ${staffId}::uuid FOR UPDATE`;
    const person = await tx.staff.findFirst({
      where: { id: staffId, restaurantId, archivedAt: null },
      include: STAFF_INCLUDE,
    });
    if (person === null) throw staffErrors.notFound();
    return person;
  }

  /** The restaurant's built-in role, created with the first person given it. */
  private builtInRole(
    tx: TransactionClient,
    restaurantId: string,
    role: AssignableRole,
  ): Promise<{ id: string }> {
    return tx.role.upsert({
      where: { restaurantId_key: { restaurantId, key: role } },
      create: {
        restaurantId,
        key: role,
        name: BUILT_IN_ROLE_NAMES[role],
        baseRole: role,
        builtIn: true,
      },
      update: {},
      select: { id: true },
    });
  }

  /** Takes the person off today's (and later) waiter assignments; returns how many went. */
  private async takeOffSections(
    tx: TransactionClient,
    restaurantId: string,
    staffId: string,
  ): Promise<number> {
    await lockSetup(tx);
    const today = await currentBusinessDate(tx, restaurantId);
    const removed = await tx.shiftAssignment.deleteMany({
      where: { restaurantId, staffId, businessDate: { gte: dbDate(today) } },
    });
    if (removed.count > 0) {
      await announceSetupChange(tx, restaurantId, 'WAITER_ASSIGNMENTS', {
        type: 'waiter_assignments',
        id: restaurantId,
      });
    }
    return removed.count;
  }

  private record(
    tx: TransactionClient,
    principal: Principal,
    action: string,
    staffId: string,
    before: unknown,
    after: unknown,
    reason?: string,
  ): Promise<unknown> {
    return this.audit.record(tx, {
      action,
      entityType: 'staff',
      entityId: staffId,
      actorId: principal.staffId,
      deviceId: principal.deviceId,
      restaurantId: principal.restaurantId,
      before,
      after,
      reason: reason ?? null,
    });
  }
}
