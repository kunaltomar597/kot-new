import { Injectable } from '@nestjs/common';
import type { RoleListResponse, RoleRequest, RoleView } from '@rp/contracts';
import { checkCustomRole, type CustomRoleProblem, extraCapabilitiesOf } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import { authErrors } from '../auth/auth-errors.js';
import { AuthSettingsService } from '../auth/auth-settings.js';
import type { Principal } from '../auth/principal.js';
import { hasFreshStepUp } from '../auth/step-up.js';
import { newId } from '../common/ids.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import type { Role } from '../generated/prisma/client.js';
import { announceSetupChange, lockSetup } from '../restaurant/setup-changes.js';

const PROBLEM_MESSAGES: Readonly<Record<CustomRoleProblem, string>> = {
  NAME_REQUIRED: 'Give the role a name.',
  NAME_TAKEN: 'Another role has this name. Choose another name.',
  BASE_ROLE_INVALID: 'A custom role is built on the cashier, waiter or kitchen role.',
  CAPABILITY_NOT_GRANTABLE:
    'Managing staff and the Owner’s own actions cannot be given to a custom role.',
  NOTHING_ADDED: 'Choose at least one thing the base role cannot already do.',
};

const BUILT_IN_NAMES = ['Owner', 'Manager', 'Cashier', 'Waiter', 'Kitchen'];

const roleErrors = {
  invalid: (problem: CustomRoleProblem) =>
    new AppError(422, `ROLE_${problem}`, PROBLEM_MESSAGES[problem]),
  notFound: () => new AppError(404, 'ROLE_NOT_FOUND', 'There is no such custom role.'),
  builtIn: () =>
    new AppError(409, 'ROLE_BUILT_IN', 'Built-in roles cannot be changed. Create a custom role.'),
  archived: () => new AppError(409, 'ROLE_ARCHIVED', 'This role is archived.'),
  inUse: (count: number) =>
    new AppError(
      409,
      'ROLE_IN_USE',
      'People have this role. Give them another role first, then try again.',
      { staffCount: count },
    ),
};

type RoleWithCount = Role & { readonly _count: { readonly staff: number } };

function view(role: RoleWithCount): RoleView {
  return {
    id: role.id,
    name: role.name,
    baseRole: role.baseRole,
    builtIn: role.builtIn,
    capabilities: role.builtIn ? [] : extraCapabilitiesOf(role.baseRole, role.capabilities),
    staffCount: role._count.staff,
    archivedAt: role.archivedAt?.toISOString() ?? null,
  };
}

const COUNT_ACTIVE_STAFF = {
  _count: { select: { staff: { where: { active: true, archivedAt: null } } } },
} as const;

/**
 * Custom roles (P4-02e, AUTH-012): the Owner combines capabilities into a named role on top of
 * the cashier, waiter or kitchen role. The permission guard and the services apply them through
 * `@rp/domain` `actorGrant`, which only ever honours what `extraCapabilitiesOf` accepts. Only the
 * Owner, with a fresh second factor (AUTH-006), creates, changes or archives one; every change is
 * audited and announced as `RestaurantChanged` `STAFF`. A role people have keeps its base role
 * and cannot be archived.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: AuthSettingsService,
  ) {}

  async list(principal: Principal): Promise<RoleListResponse> {
    const roles = await this.prisma.role.findMany({
      where: { restaurantId: principal.restaurantId },
      include: COUNT_ACTIVE_STAFF,
      orderBy: [{ builtIn: 'desc' }, { name: 'asc' }],
    });
    return { roles: roles.map(view) };
  }

  async create(principal: Principal, request: RoleRequest): Promise<RoleView> {
    await this.requireOwner(principal);
    return this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      await this.check(tx, principal.restaurantId, request, null);
      const capabilities = extraCapabilitiesOf(request.baseRole, request.capabilities);
      const role = await tx.role.create({
        data: {
          restaurantId: principal.restaurantId,
          key: `custom:${newId()}`,
          name: request.name,
          baseRole: request.baseRole,
          builtIn: false,
          capabilities,
        },
        include: COUNT_ACTIVE_STAFF,
      });
      await this.record(tx, principal, 'ROLE_CREATED', role.id, null, {
        name: role.name,
        baseRole: role.baseRole,
        capabilities,
      });
      await announceSetupChange(tx, principal.restaurantId, 'STAFF', { type: 'role', id: role.id });
      return view(role);
    });
  }

  async update(principal: Principal, roleId: string, request: RoleRequest): Promise<RoleView> {
    await this.requireOwner(principal);
    return this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      const existing = await this.customRole(tx, principal.restaurantId, roleId);
      if (existing.archivedAt !== null) throw roleErrors.archived();
      // People's own role is the base role: it never changes under them.
      if (existing.baseRole !== request.baseRole && existing._count.staff > 0) {
        throw roleErrors.inUse(existing._count.staff);
      }
      await this.check(tx, principal.restaurantId, request, roleId);
      const capabilities = extraCapabilitiesOf(request.baseRole, request.capabilities);
      const before = {
        name: existing.name,
        baseRole: existing.baseRole,
        capabilities: extraCapabilitiesOf(existing.baseRole, existing.capabilities),
      };
      const after = { name: request.name, baseRole: request.baseRole, capabilities };
      if (JSON.stringify(before) === JSON.stringify(after)) return view(existing);
      const role = await tx.role.update({
        where: { id: roleId },
        data: after,
        include: COUNT_ACTIVE_STAFF,
      });
      await this.record(tx, principal, 'ROLE_CHANGED', roleId, before, after);
      await announceSetupChange(tx, principal.restaurantId, 'STAFF', { type: 'role', id: roleId });
      return view(role);
    });
  }

  async archive(principal: Principal, roleId: string, reason: string): Promise<RoleView> {
    await this.requireOwner(principal);
    return this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      const existing = await this.customRole(tx, principal.restaurantId, roleId);
      if (existing.archivedAt !== null) return view(existing);
      if (existing._count.staff > 0) throw roleErrors.inUse(existing._count.staff);
      // Deactivated people keep the role on their record for the audit trail.
      const role = await tx.role.update({
        where: { id: roleId },
        data: { archivedAt: new Date() },
        include: COUNT_ACTIVE_STAFF,
      });
      await this.record(
        tx,
        principal,
        'ROLE_ARCHIVED',
        roleId,
        { archivedAt: null },
        { archivedAt: role.archivedAt?.toISOString() ?? null },
        reason,
      );
      await announceSetupChange(tx, principal.restaurantId, 'STAFF', { type: 'role', id: roleId });
      return view(role);
    });
  }

  /** Only the Owner, having confirmed password and authenticator just now (AUTH-006). */
  private async requireOwner(principal: Principal): Promise<void> {
    if (principal.role !== 'OWNER') throw authErrors.ownerOnly();
    const settings = await this.settings.get(principal.restaurantId);
    if (!hasFreshStepUp(principal, settings.stepUpMinutes)) {
      throw authErrors.secondFactorRequired();
    }
  }

  private async check(
    tx: TransactionClient,
    restaurantId: string,
    request: RoleRequest,
    selfId: string | null,
  ): Promise<void> {
    const others = await tx.role.findMany({
      where: { restaurantId, archivedAt: null, ...(selfId !== null && { NOT: { id: selfId } }) },
      select: { name: true },
    });
    // The built-in roles' names are taken even before anyone has the role.
    const [problem] = checkCustomRole(request, [
      ...BUILT_IN_NAMES,
      ...others.map((other) => other.name),
    ]);
    if (problem !== undefined) throw roleErrors.invalid(problem);
  }

  private async customRole(
    tx: TransactionClient,
    restaurantId: string,
    roleId: string,
  ): Promise<RoleWithCount> {
    const role = await tx.role.findFirst({
      where: { id: roleId, restaurantId },
      include: COUNT_ACTIVE_STAFF,
    });
    if (role === null) throw roleErrors.notFound();
    if (role.builtIn) throw roleErrors.builtIn();
    return role;
  }

  private record(
    tx: TransactionClient,
    principal: Principal,
    action: string,
    roleId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
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
