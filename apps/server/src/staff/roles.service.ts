import { Injectable } from '@nestjs/common';
import type { CustomRoleRequest, CustomRoleView, RoleListResponse } from '@rp/contracts';
import {
  type AssignableRole,
  CAPABILITIES,
  checkCustomRole,
  grantOf,
  isAssignableRole,
  type RoleCustomisation,
} from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import { authErrors } from '../auth/auth-errors.js';
import { AuthSettingsService } from '../auth/auth-settings.js';
import { customisationOf, holderOf } from '../auth/custom-roles.js';
import type { Principal } from '../auth/principal.js';
import { hasFreshStepUp } from '../auth/step-up.js';
import { newId } from '../common/ids.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import type { StaffRole } from '../generated/prisma/enums.js';
import { announceSetupChange, lockSetup } from '../restaurant/setup-changes.js';
import { roleErrors } from './role-errors.js';
import { takeOffSections } from './sections.js';

/** Names everyone already knows roles by (BRD §4.2): a custom role never takes one. */
const BUILT_IN_NAMES = ['Owner', 'Manager', 'Cashier', 'Waiter', 'Kitchen'];

/** Active people, the ones a role's changes reach. */
const ACTIVE_STAFF = { active: true, archivedAt: null } as const;

const ROLE_SELECT = {
  id: true,
  name: true,
  baseRole: true,
  capabilities: true,
  removedCapabilities: true,
  archivedAt: true,
  updatedAt: true,
  _count: { select: { staff: { where: ACTIVE_STAFF } } },
} as const;

interface RoleViewRow {
  readonly id: string;
  readonly name: string;
  readonly baseRole: StaffRole;
  readonly capabilities: readonly string[];
  readonly removedCapabilities: readonly string[];
  readonly archivedAt: Date | null;
  readonly updatedAt: Date;
  readonly _count: { readonly staff: number };
}

/** A custom role's base role; the Owner's role is never one (`CustomRoleRequest`). */
function baseRoleOf(role: Pick<RoleViewRow, 'baseRole'>): AssignableRole {
  if (!isAssignableRole(role.baseRole)) throw new Error('A custom role is built on the Owner');
  return role.baseRole;
}

function customisation(role: RoleViewRow): RoleCustomisation {
  return customisationOf({ ...role, builtIn: false }) ?? { added: [], removed: [] };
}

function view(role: RoleViewRow): CustomRoleView {
  const { added, removed } = customisation(role);
  return {
    id: role.id,
    name: role.name,
    baseRole: baseRoleOf(role),
    added: [...added],
    removed: [...removed],
    staffCount: role._count.staff,
    archivedAt: role.archivedAt?.toISOString() ?? null,
    updatedAt: role.updatedAt.toISOString(),
  };
}

/** What the audit keeps of a role: its name, base role and permissions. */
function described(role: RoleViewRow) {
  const { added, removed } = customisation(role);
  return { name: role.name, baseRole: role.baseRole, added, removed };
}

/** In the permission matrix's order, so a role reads the same however it was sent. */
function inMatrixOrder(capabilities: readonly string[]): string[] {
  return CAPABILITIES.filter((capability) => capabilities.includes(capability));
}

/**
 * Custom roles (P4-02e, AUTH-012): the Owner combines permissions into a named role on top of a
 * base role (`checkCustomRole` in `@rp/domain` says what may be added or taken away). Creating,
 * changing, archiving and restoring one needs the Owner with a fresh second factor (AUTH-006),
 * since a role decides who manages staff and who is a manager. Roles are archived, never deleted,
 * and only when no active person has them. People who have a role work with its new permissions
 * from their next request; their live connections close (the gateway compares permission keys).
 * Every change is audited and announced as `RestaurantChanged` `STAFF`.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AuthSettingsService,
    private readonly audit: AuditService,
  ) {}

  /** Every custom role, archived ones included, by name (managers offer them to people). */
  async list(principal: Principal): Promise<RoleListResponse> {
    const roles = await this.prisma.role.findMany({
      where: { restaurantId: principal.restaurantId, builtIn: false },
      select: ROLE_SELECT,
      orderBy: { name: 'asc' },
    });
    return { roles: roles.map(view) };
  }

  async create(principal: Principal, request: CustomRoleRequest): Promise<CustomRoleView> {
    await this.requireOwner(principal);
    this.requireValid(request);
    const { restaurantId } = principal;
    const role = await this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      await this.requireNameFree(tx, restaurantId, request.name, null);
      const id = newId();
      const created = await tx.role.create({
        data: {
          id,
          restaurantId,
          key: `custom:${id}`,
          name: request.name,
          baseRole: request.baseRole,
          builtIn: false,
          capabilities: inMatrixOrder(request.added),
          removedCapabilities: inMatrixOrder(request.removed),
        },
        select: ROLE_SELECT,
      });
      await this.record(tx, principal, 'ROLE_CREATED', id, null, described(created));
      await announceSetupChange(tx, restaurantId, 'STAFF', { type: 'role', id });
      return created;
    });
    return view(role);
  }

  /**
   * Name, base role and permissions. People who have the role and no longer take orders leave
   * today's sections, as when someone is given such a role (P4-02a).
   */
  async update(
    principal: Principal,
    roleId: string,
    request: CustomRoleRequest,
  ): Promise<CustomRoleView> {
    await this.requireOwner(principal);
    this.requireValid(request);
    const { restaurantId } = principal;
    const role = await this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      const before = await this.locked(tx, restaurantId, roleId);
      if (before.archivedAt !== null) throw roleErrors.archived();
      await this.requireNameFree(tx, restaurantId, request.name, roleId);
      const added = inMatrixOrder(request.added);
      const removed = inMatrixOrder(request.removed);
      const unchanged =
        before.name === request.name &&
        before.baseRole === request.baseRole &&
        added.join() === inMatrixOrder(before.capabilities).join() &&
        removed.join() === inMatrixOrder(before.removedCapabilities).join();
      if (unchanged) return before;

      const after = await tx.role.update({
        where: { id: roleId },
        data: {
          name: request.name,
          baseRole: request.baseRole,
          capabilities: added,
          removedCapabilities: removed,
        },
        select: ROLE_SELECT,
      });
      const tookOrders = grantOf(this.holder(before), 'ORDER_CREATE') !== 'DENY';
      const takesOrders = grantOf(this.holder(after), 'ORDER_CREATE') !== 'DENY';
      let leftSections = 0;
      if (tookOrders && !takesOrders) {
        const holders = await tx.staff.findMany({
          where: { restaurantId, roleId, ...ACTIVE_STAFF },
          select: { id: true },
        });
        leftSections = await takeOffSections(
          tx,
          restaurantId,
          holders.map((person) => person.id),
        );
      }
      await this.record(tx, principal, 'ROLE_CHANGED', roleId, described(before), {
        ...described(after),
        staffCount: after._count.staff,
        ...(leftSections > 0 && { leftSections }),
      });
      await announceSetupChange(tx, restaurantId, 'STAFF', { type: 'role', id: roleId });
      return after;
    });
    return view(role);
  }

  /** Only a role no active person has; deactivated people keep it in their records. */
  async archive(principal: Principal, roleId: string, reason: string): Promise<CustomRoleView> {
    await this.requireOwner(principal);
    const { restaurantId } = principal;
    const role = await this.prisma.transaction(async (tx) => {
      const before = await this.locked(tx, restaurantId, roleId);
      if (before.archivedAt !== null) throw roleErrors.alreadyArchived();
      if (before._count.staff > 0) throw roleErrors.inUse(before._count.staff);
      const after = await tx.role.update({
        where: { id: roleId },
        data: { archivedAt: new Date() },
        select: ROLE_SELECT,
      });
      await this.record(
        tx,
        principal,
        'ROLE_ARCHIVED',
        roleId,
        { archived: false },
        { archived: true, name: after.name },
        reason,
      );
      await announceSetupChange(tx, restaurantId, 'STAFF', { type: 'role', id: roleId });
      return after;
    });
    return view(role);
  }

  async restore(principal: Principal, roleId: string): Promise<CustomRoleView> {
    await this.requireOwner(principal);
    const { restaurantId } = principal;
    const role = await this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      const before = await this.locked(tx, restaurantId, roleId);
      if (before.archivedAt === null) throw roleErrors.notArchived();
      await this.requireNameFree(tx, restaurantId, before.name, roleId);
      const after = await tx.role.update({
        where: { id: roleId },
        data: { archivedAt: null },
        select: ROLE_SELECT,
      });
      await this.record(
        tx,
        principal,
        'ROLE_RESTORED',
        roleId,
        { archived: true },
        { archived: false, name: after.name },
      );
      await announceSetupChange(tx, restaurantId, 'STAFF', { type: 'role', id: roleId });
      return after;
    });
    return view(role);
  }

  /** The Owner, having confirmed password and second factor within `auth.stepUpMinutes`. */
  private async requireOwner(principal: Principal): Promise<void> {
    if (principal.role !== 'OWNER') throw authErrors.ownerOnly();
    const settings = await this.settings.get(principal.restaurantId);
    if (!hasFreshStepUp(principal, settings.stepUpMinutes)) {
      throw authErrors.secondFactorRequired();
    }
  }

  private requireValid(request: CustomRoleRequest): void {
    const issues = checkCustomRole(request.baseRole, request);
    if (issues.length > 0) throw roleErrors.permissionsInvalid(issues);
  }

  /** Names are unique, ignoring case, among active custom roles and the built-in roles. */
  private async requireNameFree(
    tx: TransactionClient,
    restaurantId: string,
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    const taken =
      BUILT_IN_NAMES.some((builtIn) => builtIn.toLowerCase() === name.toLowerCase()) ||
      (await tx.role.findFirst({
        where: {
          restaurantId,
          builtIn: false,
          archivedAt: null,
          name: { equals: name, mode: 'insensitive' },
          ...(exceptId !== null && { id: { not: exceptId } }),
        },
        select: { id: true },
      })) !== null;
    if (taken) throw roleErrors.nameTaken(name);
  }

  /**
   * The custom role, locked for the rest of the transaction: giving it to someone (which locks it
   * for share) waits, so nobody gets a role while it changes or is archived.
   */
  private async locked(
    tx: TransactionClient,
    restaurantId: string,
    roleId: string,
  ): Promise<RoleViewRow> {
    await tx.$queryRaw`SELECT 1 AS locked FROM roles WHERE id = ${roleId}::uuid FOR UPDATE`;
    const role = await tx.role.findFirst({
      where: { id: roleId, restaurantId, builtIn: false },
      select: ROLE_SELECT,
    });
    if (role === null) throw roleErrors.notFound();
    return role;
  }

  private holder(role: RoleViewRow) {
    return holderOf({ ...role, builtIn: false });
  }

  private record(
    tx: TransactionClient,
    principal: Principal,
    action: string,
    roleId: string,
    before: unknown,
    after: unknown,
    reason?: string,
  ): Promise<unknown> {
    return this.audit.record(tx, {
      action,
      entityType: 'role',
      entityId: roleId,
      actorId: principal.staffId,
      deviceId: principal.deviceId,
      restaurantId: principal.restaurantId,
      before,
      after,
      reason: reason ?? null,
    });
  }
}
