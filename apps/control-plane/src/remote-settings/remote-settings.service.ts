import { Injectable } from '@nestjs/common';
import { REMOTE_SETTING_KEYS, settingDefinition } from '@rp/contracts';
import type {
  FleetRemoteSettingsView,
  InstallationRemoteSettingsView,
  PushedSettings,
  RemoteSettingDefinition,
  RemoteSettingValues,
} from '@rp/contracts/control-plane';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { CpError } from '../errors/cp-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import { settingsDigest } from './settings-digest.js';

const FLEET = 'fleet';
const Values = z.record(z.string(), z.unknown());

function valuesOf(json: Prisma.JsonValue | undefined): RemoteSettingValues {
  const parsed = Values.safeParse(json);
  return parsed.success ? parsed.data : {};
}

/** How the web app edits a setting: a switch, or a whole number between limits. */
function definitionView(key: string): RemoteSettingDefinition {
  const definition = settingDefinition(key);
  if (definition === undefined) throw new Error(`Unknown remote setting ${key}`);
  const schema = definition.schema;
  const number = schema instanceof z.ZodNumber ? schema : undefined;
  return {
    key,
    description: definition.description,
    defaultValue: definition.defaultValue,
    kind: number === undefined ? 'BOOLEAN' : 'INTEGER',
    min: number?.minValue ?? null,
    max: number?.maxValue ?? null,
    unit: definition.unit ?? null,
  };
}

/** Only keys the vendor may push, each with a value its setting allows. */
function validated(values: RemoteSettingValues): RemoteSettingValues {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const definition = REMOTE_SETTING_KEYS.includes(key) ? settingDefinition(key) : undefined;
    if (definition === undefined) {
      problems.push(`"${key}" is not a setting the vendor can push.`);
    } else if (!definition.schema.safeParse(value).success) {
      problems.push(`That value is not allowed for "${key}".`);
    }
  }
  if (problems.length > 0) {
    throw new CpError(422, 'REMOTE_SETTINGS_INVALID', problems.join(' '), { problems });
  }
  return values;
}

/**
 * Remote configuration (UPD-010, P7-08c): vendor settings and feature flags for the fleet, and
 * a PC's own values over them. Each heartbeat answer carries what the PC should hold until it
 * reports that digest. Only the Super Admin changes them; every change is audited with a reason.
 */
@Injectable()
export class RemoteSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async fleet(): Promise<FleetRemoteSettingsView> {
    const row = await this.prisma.remoteSettings.findUnique({ where: { scope: FLEET } });
    return {
      definitions: REMOTE_SETTING_KEYS.map(definitionView),
      fleet: valuesOf(row?.values),
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  async installation(installationId: string): Promise<InstallationRemoteSettingsView> {
    const installation = await this.prisma.installation.findUnique({
      where: { id: installationId },
      select: { id: true, settingsDigest: true },
    });
    if (installation === null) {
      throw new CpError(404, 'NOT_FOUND', 'The installation was not found.');
    }
    const rows = await this.prisma.remoteSettings.findMany({
      where: { scope: { in: [FLEET, installationId] } },
    });
    const fleet = valuesOf(rows.find((row) => row.scope === FLEET)?.values);
    const own = rows.find((row) => row.scope === installationId);
    const overrides = valuesOf(own?.values);
    const effective = { ...fleet, ...overrides };
    return {
      installationId,
      fleet,
      overrides,
      effective,
      digest: settingsDigest(effective),
      appliedDigest: installation.settingsDigest,
      updatedAt: own?.updatedAt.toISOString() ?? null,
    };
  }

  async setFleet(
    values: RemoteSettingValues,
    reason: string,
    actor: string,
  ): Promise<FleetRemoteSettingsView> {
    await this.save(FLEET, validated(values), reason, actor, 'fleet', null);
    return this.fleet();
  }

  async setInstallation(
    installationId: string,
    values: RemoteSettingValues,
    reason: string,
    actor: string,
  ): Promise<InstallationRemoteSettingsView> {
    await this.installation(installationId);
    await this.save(
      installationId,
      validated(values),
      reason,
      actor,
      'installation',
      installationId,
    );
    return this.installation(installationId);
  }

  private async save(
    scope: string,
    values: RemoteSettingValues,
    reason: string,
    actor: string,
    targetType: string,
    targetId: string | null,
  ): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      const before = await tx.remoteSettings.findUnique({ where: { scope } });
      const json = values as Prisma.InputJsonObject;
      await tx.remoteSettings.upsert({
        where: { scope },
        create: { scope, values: json, updatedAt: new Date(), updatedBy: actor },
        update: { values: json, updatedAt: new Date(), updatedBy: actor },
      });
      await this.audit.record(tx, {
        actor,
        action: 'remote_settings.changed',
        targetType,
        targetId,
        details: {
          reason,
          before: (before?.values ?? {}) as Prisma.InputJsonValue,
          after: json,
        },
      });
    });
  }

  /**
   * For a heartbeat answer: the values the PC should hold, unless the digest it reported says it
   * holds them already. A PC older than P7-08c (no digest field) is sent nothing.
   */
  async forHeartbeat(
    installationId: string,
    reported: { readonly digest: string | null } | undefined,
  ): Promise<PushedSettings | null> {
    if (reported === undefined) return null;
    const view = await this.installation(installationId);
    if (view.appliedDigest !== reported.digest) {
      await this.prisma.installation.update({
        where: { id: installationId },
        data: { settingsDigest: reported.digest },
      });
    }
    return reported.digest === view.digest ? null : { digest: view.digest, values: view.effective };
  }
}
