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
  grantOf,
  isAssignableRole,
  isValidPin,
  type RoleChoice,
  type StaffChange,
  type StaffTarget,
} from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import { type AuthSettings, AuthSettingsService } from '../auth/auth-settings.js';
import { CredentialHasher } from '../auth/credential-hasher.js';
import { customisationOf, ROLE_GRANTS_SELECT, type RoleRow } from '../auth/custom-roles.js';
import type { Principal } from '../auth/principal.js';
import { hasFreshStepUp } from '../auth/step-up.js';
import { currentBusinessDate, dbDate } from '../common/business-dates.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { PagerBroker } from '../pagers/pager-broker.js';
import { announceSetupChange, lockSetup } from '../restaurant/setup-changes.js';
import { roleErrors } from './role-errors.js';
import { staffErrors } from './staff-errors.js';

const STAFF_INCLUDE = {
  role: { select: ROLE_GRANTS_SELECT },
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
  readonly role: RoleRow;
  readonly credentials: readonly { readonly kind: string; readonly lockedUntil: Date | null }[];
}

/** Names of the built-in roles, created with the first person given each role. */
const BUILT_IN_ROLE_NAMES: Readonly<Record<AssignableRole, string>> = {
  MANAGER: 'Manager',
  CASHIER: 'Cashier',
  WAITER: 'Waiter',
  KITCHEN: 'Kitchen',
};

/** A person's custom role by name, for their record and the audit; null for a built-in role. */
function customRoleOf(role: RoleRow): StaffView['customRole'] {
  return role.builtIn ? null : { id: role.id, name: role.name };
}

function subjectOf(person: StaffRow): StaffTarget {
  return {
    staffId: person.id,
    role: person.role.baseRole,
    customRole: customisationOf(person.role),
    active: person.active,
  };
}

/** The role a person is being given, for the staff rules; `customRoleId` null for a built-in one. */
interface NewRole {
  readonly choice: RoleChoice;
  readonly customRoleId: string | null;
}

function customChoice(role: RoleRow): NewRole {
  if (!isAssignableRole(role.baseRole)) throw roleErrors.unavailable();
  return {
    choice: { role: role.baseRole, customRole: customisationOf(role) },
    customRoleId: role.id,
  };
}

function view(person: StaffRow, now: Date): StaffView {
  const locks = person.credentials
    .map((credential) => credential.lockedUntil)
    .filter((until): until is Date => until !== null && until > now)
    .sort((a, b) => b.getTime() - a.getTime());
  return {
    id: person.id,
    displayName: person.displayName,
    role: person.role.baseRole,
    customRole: customRoleOf(person.role),
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

/**
 * Staff administration (P4-02a, MGR-004): adding people, their roles and PINs, deactivating and
 * reactivating them; never deleting (AUD-004). Who may change whom is `decideStaffChange`
 * (`@rp/domain`), including the Owner's fresh second factor for creating or removing managers
 * (AUTH-006). A custom role (P4-02e, AUTH-012) is given like its base role; one that makes
 * someone a manager counts as a manager. PINs are hashed with the pepper and never stored, logged
 * or audited (AUTH-002). Every change is audited in its own transaction and announced as
 * `RestaurantChanged` `STAFF`, so login tiles and staff lists are read again.
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
    const { restaurantId } = principal;
    const customRoleId = request.customRoleId ?? null;
    // Checked before the PIN is hashed, and again under lock in the transaction.
    const given: NewRole =
      customRoleId === null
        ? { choice: { role: request.role, customRole: null }, customRoleId: null }
        : customChoice(await this.customRole(this.prisma, restaurantId, customRoleId, request.role));
    this.require(principal, settings, null, { kind: 'CREATE', ...given.choice });
    this.requirePinLength(request.pin, settings);
    const secretHash = await this.hasher.hash(request.pin);
    const person = await this.prisma.transaction(async (tx) => {
      const roleId = await this.roleIdFor(tx, principal, settings, null, given);
      const created = await tx.staff.create({
        data: {
          restaurantId,
          roleId,
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
        customRole: customRoleOf(created.role),
        hasPhone: created.phone !== null,
        hasEmail: created.email !== null,
      });
      await announceSetupChange(tx, restaurantId, 'STAFF', { type: 'staff', id: created.id });
      return created;
    });
    return view(person, new Date());
  }

  /**
   * Name, contact and role. A new role or custom role applies to the person's next request, and
   * their live connections close so their screens sign in again with it (AUTH-010); someone who
   * no longer takes orders leaves today's sections.
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
      const newRole = await this.newRole(tx, restaurantId, target, request);
      const details = (['displayName', 'phone', 'email'] as const).filter(
        (field) => request[field] !== undefined && request[field] !== target[field],
      );
      if (details.length > 0) this.require(principal, settings, target, { kind: 'EDIT' });
      const roleId =
        newRole === undefined
          ? undefined
          : await this.roleIdFor(tx, principal, settings, target, newRole);
      if (details.length === 0 && roleId === undefined) return target;

      const updated = await tx.staff.update({
        where: { id: target.id },
        data: {
          ...(request.displayName !== undefined && { displayName: request.displayName }),
          ...(request.phone !== undefined && { phone: request.phone }),
          ...(request.email !== undefined && { email: request.email }),
          ...(roleId !== undefined && { roleId }),
        },
        include: STAFF_INCLUDE,
      });
      const leftSections =
        newRole !== undefined && grantOf(newRole.choice, 'ORDER_CREATE') === 'DENY'
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
          ...(newRole !== undefined && {
            role: target.role.baseRole,
            customRole: customRoleOf(target.role),
          }),
        },
        {
          ...(details.includes('displayName') && { displayName: updated.displayName }),
          ...(newRole !== undefined && {
            role: updated.role.baseRole,
            customRole: customRoleOf(updated.role),
          }),
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
      customRole: principal.customRole ?? null,
      secondFactorFresh: hasFreshStepUp(principal, settings.stepUpMinutes),
    };
    const decision = decideStaffChange(actor, target === null ? null : subjectOf(target), change);
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

  /**
   * The role `request` gives the person, or undefined when they keep theirs: the custom role
   * `customRoleId`, or the built-in role `role` (their base role when `customRoleId` is null). A
   * person keeps an archived custom role they already have.
   */
  private async newRole(
    tx: TransactionClient,
    restaurantId: string,
    target: StaffRow,
    request: UpdateStaffRequest,
  ): Promise<NewRole | undefined> {
    const current = target.role;
    const { customRoleId, role } = request;
    if (customRoleId !== undefined && customRoleId !== null) {
      if (customRoleId === current.id && (role === undefined || role === current.baseRole)) {
        return undefined;
      }
      return customChoice(await this.customRole(tx, restaurantId, customRoleId, role));
    }
    if (customRoleId === undefined && role === undefined) return undefined;
    const base = role ?? current.baseRole;
    if (current.builtIn && base === current.baseRole) return undefined;
    // Only the Owner's role cannot be given, and the Owner keeps it.
    if (!isAssignableRole(base)) throw staffErrors.refused('OWNER_RECORD');
    return { choice: { role: base, customRole: null }, customRoleId: null };
  }

  /**
   * Checks that the actor may give `given` and returns its role row's id. A custom role is locked
   * for the rest of the transaction, so it cannot change or be archived meanwhile, and checked
   * again as it now is.
   */
  private async roleIdFor(
    tx: TransactionClient,
    principal: Principal,
    settings: AuthSettings,
    target: StaffRow | null,
    given: NewRole,
  ): Promise<string> {
    const kind = target === null ? 'CREATE' : 'CHANGE_ROLE';
    if (given.customRoleId === null) {
      this.require(principal, settings, target, { kind, ...given.choice });
      return (await this.builtInRole(tx, principal.restaurantId, given.choice.role)).id;
    }
    const locked = customChoice(
      await this.customRole(tx, principal.restaurantId, given.customRoleId, given.choice.role, true),
    );
    this.require(principal, settings, target, { kind, ...locked.choice });
    return given.customRoleId;
  }

  /**
   * The active custom role `roleId`, which must be built on `baseRole` when one is given; with
   * `lock`, locked against changes and archiving for the rest of the transaction.
   */
  private async customRole(
    db: TransactionClient,
    restaurantId: string,
    roleId: string,
    baseRole: AssignableRole | undefined,
    lock = false,
  ): Promise<RoleRow> {
    if (lock) await db.$queryRaw`SELECT 1 AS locked FROM roles WHERE id = ${roleId}::uuid FOR SHARE`;
    const role = await db.role.findFirst({
      where: { id: roleId, restaurantId, builtIn: false, archivedAt: null },
      select: ROLE_GRANTS_SELECT,
    });
    if (role === null) throw roleErrors.unavailable();
    if (baseRole !== undefined && role.baseRole !== baseRole) throw roleErrors.mismatch();
    return role;
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
