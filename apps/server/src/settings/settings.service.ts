import { Injectable } from '@nestjs/common';
import {
  crossSettingProblems,
  REMOTE_SETTING_KEYS,
  SETTINGS,
  type SettingDefinition,
  type SettingKey,
  type SettingValue,
  type SettingsExport,
  type SettingsImportResponse,
  type SettingView,
  settingDefinition,
  type UpdateSettingRequest,
} from '@rp/contracts';
import {
  businessDateOf,
  canonicalJson,
  actorGrant,
  OWNER_SECOND_FACTOR_CAPABILITIES,
} from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import { authErrors } from '../auth/auth-errors.js';
import type { Principal } from '../auth/principal.js';
import { hasFreshStepUp } from '../auth/step-up.js';
import { newId } from '../common/ids.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { appendEvent } from '../events/outbox.js';
import { Prisma } from '../generated/prisma/client.js';

/** Settings are read at most this often per restaurant (they change rarely; requests are many). */
const CACHE_MS = 30_000;

interface StoredSetting {
  readonly value: unknown;
  readonly updatedAt: Date;
}

function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * The effective settings of one restaurant: the stored value when it is valid, the catalogue's
 * default otherwise (a value stored under an older catalogue that no longer validates falls back
 * to the default instead of breaking the server).
 */
export class SettingsSnapshot {
  constructor(private readonly stored: ReadonlyMap<string, StoredSetting>) {}

  get<K extends SettingKey>(key: K): SettingValue<K> {
    return this.valueOf(key) as SettingValue<K>;
  }

  /** The value by an unchecked key (the catalogue must know it). */
  valueOf(key: string): unknown {
    const definition = settingDefinition(key);
    if (definition === undefined) throw new Error(`Unknown setting ${key}`);
    const stored = this.stored.get(key);
    if (stored !== undefined) {
      const parsed = definition.schema.safeParse(stored.value);
      if (parsed.success) return parsed.data;
    }
    return definition.defaultValue;
  }

  updatedAt(key: string): Date | null {
    return this.stored.get(key)?.updatedAt ?? null;
  }

  /** Every setting's effective value, by key. */
  all(): Record<string, unknown> {
    return Object.fromEntries(
      SETTINGS.map((definition) => [definition.key, this.valueOf(definition.key)]),
    );
  }
}

/**
 * The settings registry (P1-01a, MGR-007): reads with a short cache, and changes with validation,
 * the capability each setting names (the Owner's second factor where AUTH-006 asks for it), an
 * audit entry with before and after (AUD-001) and a `SettingsChanged` event, in one transaction.
 * Vendor-controlled settings (UPD-010) are read-only here.
 */
@Injectable()
export class SettingsService {
  private readonly cache = new Map<string, { at: number; snapshot: Promise<SettingsSnapshot> }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  snapshot(restaurantId: string): Promise<SettingsSnapshot> {
    const now = Date.now();
    const cached = this.cache.get(restaurantId);
    if (cached !== undefined && now - cached.at < CACHE_MS) return cached.snapshot;
    const snapshot = this.load(restaurantId);
    snapshot.catch(() => this.cache.delete(restaurantId));
    this.cache.set(restaurantId, { at: now, snapshot });
    return snapshot;
  }

  /** Forget cached values (after a change, or when a test writes settings directly). */
  invalidate(): void {
    this.cache.clear();
  }

  async list(principal: Principal): Promise<SettingView[]> {
    const snapshot = await this.snapshot(principal.restaurantId);
    return SETTINGS.map((definition) =>
      this.view(definition as SettingDefinition, snapshot, principal),
    );
  }

  async update(
    principal: Principal,
    key: string,
    request: UpdateSettingRequest,
  ): Promise<SettingView> {
    const definition = settingDefinition(key);
    if (definition === undefined) {
      throw new AppError(404, 'SETTING_NOT_FOUND', `There is no setting "${key}".`);
    }
    if (definition.scope === 'VENDOR') {
      throw new AppError(
        403,
        'SETTING_VENDOR_CONTROLLED',
        'The vendor sets this value through the Control Plane; it cannot be changed here.',
      );
    }
    const snapshot = await this.snapshot(principal.restaurantId);
    if (
      actorGrant(
        { role: principal.role, extraCapabilities: principal.capabilities },
        definition.capability,
      ) !== 'ALLOW'
    )
      throw authErrors.forbidden();
    if (
      OWNER_SECOND_FACTOR_CAPABILITIES.has(definition.capability) &&
      !hasFreshStepUp(principal, snapshot.get('auth.stepUpMinutes'))
    ) {
      throw authErrors.secondFactorRequired();
    }

    const parsed = definition.schema.safeParse(request.value);
    if (!parsed.success) {
      throw new AppError(422, 'SETTING_INVALID', `That value is not allowed for ${key}.`, {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    const value: unknown = parsed.data;
    const problems = crossSettingProblems({ ...snapshot.all(), [key]: value });
    if (problems.length > 0) {
      throw new AppError(422, 'SETTING_CONFLICT', problems.join(' '), { problems });
    }
    const before = snapshot.valueOf(key);
    if (same(before, value)) return this.view(definition, snapshot, principal);

    const now = new Date();
    await this.prisma.transaction(async (tx) => {
      const json = value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
      const row = await tx.setting.upsert({
        where: { restaurantId_key: { restaurantId: principal.restaurantId, key } },
        create: {
          restaurantId: principal.restaurantId,
          key,
          value: json,
          updatedById: principal.staffId,
        },
        update: { value: json, updatedById: principal.staffId },
      });
      const restaurant = await tx.restaurant.findUniqueOrThrow({
        where: { id: principal.restaurantId },
      });
      await appendEvent(
        tx,
        {
          eventId: newId(),
          type: 'SettingsChanged',
          version: 1,
          occurredAt: now.toISOString(),
          restaurantId: principal.restaurantId,
          businessDate: businessDateOf(now, {
            cutoff: restaurant.businessDayCutoff,
            timeZone: restaurant.timeZone,
          }),
          payload: { keys: [key] },
        },
        { aggregate: { type: 'setting', id: row.id } },
      );
      await this.audit.record(tx, {
        action: 'SETTING_CHANGED',
        entityType: 'setting',
        entityId: row.id,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        before: { key, value: before },
        after: { key, value },
        reason: request.reason ?? null,
      });
    });
    this.invalidate();
    return this.view(definition, await this.snapshot(principal.restaurantId), principal);
  }

  /** The restaurant's settings changed from their default, for a new PC (ONB-010). */
  async exportValues(restaurantId: string): Promise<SettingsExport> {
    const [snapshot, restaurant] = await Promise.all([
      this.snapshot(restaurantId),
      this.prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId } }),
    ]);
    const values: Record<string, unknown> = {};
    for (const definition of SETTINGS) {
      if (definition.scope !== 'RESTAURANT') continue;
      const value = snapshot.valueOf(definition.key);
      if (!same(value, definition.defaultValue)) values[definition.key] = value;
    }
    return {
      format: 1,
      exportedAt: new Date().toISOString(),
      restaurantName: restaurant.displayName,
      values,
    };
  }

  /**
   * Applies settings from an export (ONB-010), each checked as a change by hand would be: a
   * setting that is unknown, the vendor's, not valid or not this person's to change is skipped
   * and listed; tax, invoice and data settings need the Owner's fresh second factor. Audited.
   */
  async importValues(
    principal: Principal,
    values: Readonly<Record<string, unknown>>,
  ): Promise<SettingsImportResponse> {
    const snapshot = await this.snapshot(principal.restaurantId);
    const skipped: SettingsImportResponse['skipped'] = [];
    const changes: { key: string; before: unknown; after: unknown }[] = [];
    for (const [key, raw] of Object.entries(values)) {
      const definition = settingDefinition(key);
      if (definition === undefined) {
        skipped.push({ key, reason: 'UNKNOWN' });
        continue;
      }
      if (definition.scope === 'VENDOR') {
        skipped.push({ key, reason: 'VENDOR' });
        continue;
      }
      const parsed = definition.schema.safeParse(raw);
      if (!parsed.success) {
        skipped.push({ key, reason: 'INVALID' });
        continue;
      }
      if (
        actorGrant(
          { role: principal.role, extraCapabilities: principal.capabilities },
          definition.capability,
        ) !== 'ALLOW'
      ) {
        skipped.push({ key, reason: 'NOT_ALLOWED' });
        continue;
      }
      const before = snapshot.valueOf(key);
      if (same(before, parsed.data)) {
        skipped.push({ key, reason: 'UNCHANGED' });
        continue;
      }
      if (
        OWNER_SECOND_FACTOR_CAPABILITIES.has(definition.capability) &&
        !hasFreshStepUp(principal, snapshot.get('auth.stepUpMinutes'))
      ) {
        throw authErrors.secondFactorRequired();
      }
      changes.push({ key, before, after: parsed.data });
    }
    const merged = {
      ...snapshot.all(),
      ...Object.fromEntries(changes.map((change) => [change.key, change.after])),
    };
    const problems = crossSettingProblems(merged);
    if (problems.length > 0) {
      throw new AppError(422, 'SETTING_CONFLICT', problems.join(' '), { problems });
    }
    if (changes.length > 0) {
      const now = new Date();
      await this.prisma.transaction(async (tx) => {
        for (const change of changes) {
          const json =
            change.after === null ? Prisma.JsonNull : (change.after as Prisma.InputJsonValue);
          await tx.setting.upsert({
            where: { restaurantId_key: { restaurantId: principal.restaurantId, key: change.key } },
            create: {
              restaurantId: principal.restaurantId,
              key: change.key,
              value: json,
              updatedById: principal.staffId,
            },
            update: { value: json, updatedById: principal.staffId },
          });
        }
        const restaurant = await tx.restaurant.findUniqueOrThrow({
          where: { id: principal.restaurantId },
        });
        await appendEvent(
          tx,
          {
            eventId: newId(),
            type: 'SettingsChanged',
            version: 1,
            occurredAt: now.toISOString(),
            restaurantId: principal.restaurantId,
            businessDate: businessDateOf(now, {
              cutoff: restaurant.businessDayCutoff,
              timeZone: restaurant.timeZone,
            }),
            payload: { keys: changes.map((change) => change.key) },
          },
          { aggregate: { type: 'restaurant', id: principal.restaurantId } },
        );
        await this.audit.record(tx, {
          action: 'SETTINGS_IMPORTED',
          entityType: 'setting',
          entityId: null,
          actorId: principal.staffId,
          deviceId: principal.deviceId,
          restaurantId: principal.restaurantId,
          before: Object.fromEntries(changes.map((change) => [change.key, change.before])),
          after: Object.fromEntries(changes.map((change) => [change.key, change.after])),
          reason: 'Imported from a settings file',
        });
      });
      this.invalidate();
    }
    return { applied: changes.map((change) => change.key), skipped };
  }

  /**
   * Applies the vendor settings and feature flags the Control Plane pushed (UPD-010, P7-08c): each
   * remote setting takes the pushed value, or its default when the vendor sent none. Values the
   * setting does not allow are ignored. Audited as the vendor's change, with before and after;
   * returns the keys that changed.
   */
  async applyVendorSettings(values: Readonly<Record<string, unknown>>): Promise<string[]> {
    const restaurant = await this.prisma.restaurant.findFirst();
    if (restaurant === null) return [];
    const snapshot = await this.snapshot(restaurant.id);
    const changes: { key: string; before: unknown; after: unknown }[] = [];
    for (const key of REMOTE_SETTING_KEYS) {
      const definition = settingDefinition(key);
      if (definition === undefined) continue;
      const pushed = Object.hasOwn(values, key)
        ? definition.schema.safeParse(values[key])
        : undefined;
      const target: unknown = pushed?.success ? pushed.data : definition.defaultValue;
      const before = snapshot.valueOf(key);
      if (!same(before, target)) changes.push({ key, before, after: target });
    }
    if (changes.length === 0) return [];
    const now = new Date();
    await this.prisma.transaction(async (tx) => {
      for (const change of changes) {
        const json =
          change.after === null ? Prisma.JsonNull : (change.after as Prisma.InputJsonValue);
        await tx.setting.upsert({
          where: { restaurantId_key: { restaurantId: restaurant.id, key: change.key } },
          create: { restaurantId: restaurant.id, key: change.key, value: json, updatedById: null },
          update: { value: json, updatedById: null },
        });
      }
      await appendEvent(
        tx,
        {
          eventId: newId(),
          type: 'SettingsChanged',
          version: 1,
          occurredAt: now.toISOString(),
          restaurantId: restaurant.id,
          businessDate: businessDateOf(now, {
            cutoff: restaurant.businessDayCutoff,
            timeZone: restaurant.timeZone,
          }),
          payload: { keys: changes.map((change) => change.key) },
        },
        { aggregate: { type: 'restaurant', id: restaurant.id } },
      );
      await this.audit.record(tx, {
        action: 'VENDOR_SETTINGS_APPLIED',
        entityType: 'setting',
        entityId: null,
        actorId: null,
        restaurantId: restaurant.id,
        before: Object.fromEntries(changes.map((change) => [change.key, change.before])),
        after: Object.fromEntries(changes.map((change) => [change.key, change.after])),
        reason: 'Set by the vendor through the Control Plane',
      });
    });
    this.invalidate();
    return changes.map((change) => change.key);
  }

  private view(
    definition: SettingDefinition,
    snapshot: SettingsSnapshot,
    principal: Principal,
  ): SettingView {
    const value = snapshot.valueOf(definition.key);
    return {
      key: definition.key,
      value,
      defaultValue: definition.defaultValue,
      isDefault: same(value, definition.defaultValue),
      scope: definition.scope,
      capability: definition.capability,
      editable:
        definition.scope === 'RESTAURANT' &&
        actorGrant(
          { role: principal.role, extraCapabilities: principal.capabilities },
          definition.capability,
        ) === 'ALLOW',
      description: definition.description,
      requirements: [...definition.requirements],
      ...(definition.unit !== undefined && { unit: definition.unit }),
      updatedAt: snapshot.updatedAt(definition.key)?.toISOString() ?? null,
    };
  }

  private async load(restaurantId: string): Promise<SettingsSnapshot> {
    const rows = await this.prisma.setting.findMany({
      where: { restaurantId },
      select: { key: true, value: true, updatedAt: true },
    });
    return new SettingsSnapshot(
      new Map(rows.map((row) => [row.key, { value: row.value, updatedAt: row.updatedAt }])),
    );
  }
}
