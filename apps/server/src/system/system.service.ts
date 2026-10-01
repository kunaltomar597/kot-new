import { resolve } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import {
  type ApproveUpdateRequest,
  DeviceType,
  STORAGE_CATEGORIES,
  type StorageCategory,
  type SystemStatusResponse,
} from '@rp/contracts';
import type { Principal } from '../auth/principal.js';
import { HeartbeatService } from '../cloud/heartbeat.service.js';
import { readOfferedUpdate } from '../cloud/control-plane-state.js';
import { SERVER_PACKAGE } from '../common/package-version.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { AuditService } from '../audit/audit.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { RelayOrdersService } from '../relay/relay-orders.service.js';
import { RelaySyncService } from '../relay/relay-sync.service.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  CATEGORY_FOLDERS,
  directoryBytes,
  driveSpace,
  storageLevel,
  usedPercent,
} from './storage-usage.js';
import { readInstallApproval, saveInstallApproval } from './system-state.js';

const errors = {
  notOffered: (version: string) =>
    new AppError(
      409,
      'UPDATE_NOT_OFFERED',
      'That version is not the update on offer. Read the System page again.',
      { version },
    ),
};

/**
 * The System page (P4-04, MGR-010, NFR-I03, DATA-006): what support asks for first, read fresh on
 * every call, and the manager's "Install now" for the update on offer (UPD-004).
 */
@Injectable()
export class SystemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly heartbeat: HeartbeatService,
    private readonly relay: RelaySyncService,
    private readonly relayOrders: RelayOrdersService,
    private readonly realtime: RealtimeGateway,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async status(principal: Principal): Promise<SystemStatusResponse> {
    const { restaurantId } = principal;
    const [database, settings, postgres, space, categories, devices, offered, approval, open] =
      await Promise.all([
        this.prisma.ping(),
        this.settings.snapshot(restaurantId),
        this.postgresVersion(),
        driveSpace(this.config.dataDir),
        this.categories(),
        this.devices(restaurantId),
        readOfferedUpdate(this.prisma),
        readInstallApproval(this.prisma),
        this.prisma.tableSession.count({ where: { restaurantId, status: 'OPEN' } }),
      ]);
    const approverId = approval?.approvedByStaffId ?? null;
    const approver =
      approverId === null
        ? null
        : await this.prisma.staff.findUnique({
            where: { id: approverId },
            select: { displayName: true },
          });
    const cloud = this.heartbeat.status();
    const qr = this.relay.status();
    const percent = space === null ? null : usedPercent(space);
    const warnPercent = settings.get('storage.warnPercent');
    const criticalPercent = settings.get('storage.criticalPercent');
    return {
      checkedAt: new Date().toISOString(),
      versions: [
        ...(this.config.productVersion === undefined
          ? []
          : [{ name: 'Restaurant PC', version: this.config.productVersion }]),
        { name: 'Server', version: SERVER_PACKAGE.version },
        { name: 'Node.js', version: process.versions.node },
        ...(postgres === null ? [] : [{ name: 'PostgreSQL', version: postgres }]),
      ],
      uptimeSeconds: Math.floor(process.uptime()),
      database: { status: database.up ? 'up' : 'down', latencyMs: database.latencyMs },
      controlPlane: {
        configured: cloud.configured,
        enrolled: cloud.installationId !== null,
        lastContactAt: cloud.lastSuccessAt?.toISOString() ?? null,
        lastError: cloud.lastError,
      },
      qrRelay: {
        configured: qr.configured,
        credential: qr.credential,
        lastContactAt: qr.lastSuccessAt?.toISOString() ?? null,
        lastError: qr.lastError,
        menuVersion: qr.menuVersion,
        realtime: this.relayOrders.realtimeSubscribed,
      },
      storage: {
        totalBytes: space?.totalBytes ?? null,
        freeBytes: space?.freeBytes ?? null,
        usedPercent: percent,
        level: storageLevel(percent, warnPercent, criticalPercent),
        warnPercent,
        criticalPercent,
        categories,
      },
      devices,
      update: {
        offered:
          offered === null
            ? null
            : {
                version: offered.version,
                channel: offered.channel,
                notes: offered.notes,
                publishedAt: offered.publishedAt,
                sizeBytes: offered.sizeBytes,
              },
        // An approval for an older version no longer applies.
        installApproval:
          approval === null || offered?.version !== approval.version
            ? null
            : {
                version: approval.version,
                approvedAt: approval.approvedAt,
                approvedBy: approver?.displayName ?? null,
              },
        maintenanceWindow: settings.get('updates.maintenanceWindow'),
        openTables: open,
      },
      backup: null,
      licence: null,
    };
  }

  /** "Install now" (UPD-004) for the version on offer; audited with the optional reason. */
  async approveUpdate(
    principal: Principal,
    request: ApproveUpdateRequest,
  ): Promise<SystemStatusResponse> {
    const offered = await readOfferedUpdate(this.prisma);
    if (offered?.version !== request.version) throw errors.notOffered(request.version);
    await this.prisma.$transaction(async (tx) => {
      const before = await readInstallApproval(tx);
      const approval = {
        version: request.version,
        approvedAt: new Date().toISOString(),
        approvedByStaffId: principal.staffId,
      };
      await saveInstallApproval(tx, approval);
      await this.audit.record(tx, {
        action: 'UPDATE_INSTALL_APPROVED',
        entityType: 'software_update',
        entityId: null,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        before,
        after: { ...approval, channel: offered.channel },
        reason: request.reason ?? null,
      });
    });
    return this.status(principal);
  }

  /** Each category's bytes (DATA-006): the database by audit and the rest, folders by size. */
  private async categories(): Promise<{ category: StorageCategory; bytes: number | null }[]> {
    const [sizes, folders] = await Promise.all([
      this.databaseSizes(),
      Promise.all(
        STORAGE_CATEGORIES.map(async (category) => {
          const folder = CATEGORY_FOLDERS[category];
          return [
            category,
            folder === undefined
              ? null
              : await directoryBytes(resolve(this.config.dataDir, folder)),
          ] as const;
        }),
      ),
    ]);
    const measured = new Map(folders);
    return STORAGE_CATEGORIES.map((category) => {
      if (category === 'TRANSACTIONS') {
        return { category, bytes: sizes === null ? null : sizes.total - sizes.audit };
      }
      if (category === 'AUDIT') return { category, bytes: sizes?.audit ?? null };
      // Logs are written there once the installer sets it up (P0-16); none yet is nothing.
      const bytes = measured.get(category) ?? null;
      return { category, bytes: bytes === null && category === 'LOGS' ? 0 : bytes };
    });
  }

  private async databaseSizes(): Promise<{ total: number; audit: number } | null> {
    try {
      const [row] = await this.prisma.$queryRaw<{ total: bigint; audit: bigint }[]>`
        SELECT pg_database_size(current_database()) AS total,
               pg_total_relation_size('audit_log') AS audit`;
      return row === undefined ? null : { total: Number(row.total), audit: Number(row.audit) };
    } catch {
      return null;
    }
  }

  private async devices(restaurantId: string): Promise<SystemStatusResponse['devices']> {
    const rows = await this.prisma.device.findMany({
      where: { restaurantId, status: 'ACTIVE' },
      select: { id: true, type: true, online: true },
    });
    const connected = this.realtime.connectedDeviceIds(restaurantId);
    return DeviceType.options.flatMap((type) => {
      const ofType = rows.filter((row) => row.type === type);
      if (ofType.length === 0) return [];
      return [
        {
          type,
          paired: ofType.length,
          // A pager is connected by its heartbeats, an app by its socket (as on the Devices page).
          connected: ofType.filter((row) => (type === 'PAGER' ? row.online : connected.has(row.id)))
            .length,
        },
      ];
    });
  }

  private async postgresVersion(): Promise<string | null> {
    try {
      const [row] = await this.prisma.$queryRaw<{ server_version: string }[]>`SHOW server_version`;
      return row?.server_version.split(' ')[0]?.slice(0, 64) ?? null;
    } catch {
      return null;
    }
  }
}
