import { Inject, Injectable } from '@nestjs/common';
import {
  DeviceType,
  type DiagnosticsResponse,
  type InstallApproval,
  type InstallNowRequest,
  type SystemUpdates,
  type SystemView,
} from '@rp/contracts';
import {
  type InstallNowRefusal,
  installNowRefusal,
  storageLevelOf,
  usedPercentOf,
} from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import {
  offeredUpdateOf,
  readEnrolment,
  readInstallApproval,
  readOfferedUpdate,
  saveInstallApproval,
} from '../cloud/control-plane-state.js';
import { HeartbeatService } from '../cloud/heartbeat.service.js';
import { readDataDrive } from '../common/data-drive.js';
import { SERVER_PACKAGE } from '../common/package-version.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { ADVISORY_LOCKS } from '../database/advisory-locks.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { DevicesService } from '../devices/devices.service.js';
import { AppError } from '../errors/app-error.js';
import { PagerBroker } from '../pagers/pager-broker.js';
import { PrinterStatusService } from '../printing/printer-status.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { StorageUsage } from './storage-usage.js';

type Client = PrismaService | TransactionClient;

function tablesOpen(count: number): string {
  return count === 1 ? '1 table is open' : `${String(count)} tables are open`;
}

/** UPD-004 refusals in plain words (NFR-U04). */
function refusal(code: InstallNowRefusal, openTables: number): AppError {
  switch (code) {
    case 'UPDATE_NOT_OFFERED':
      return AppError.conflict(
        code,
        'That update is not offered any more. Read the System page again to see what is offered now.',
      );
    case 'TABLES_OPEN':
      return AppError.conflict(
        code,
        `${tablesOpen(openTables)}. An update installs only when every table is closed: settle or free them, then press Install now again.`,
        { openTables },
      );
    case 'REASON_REQUIRED':
      return AppError.conflict(
        code,
        `${tablesOpen(openTables)}. This security update can install anyway, but say why it cannot wait.`,
        { openTables },
      );
  }
}

/** "Send diagnostics" failures, from the heartbeat's last error (UPD-008). */
function diagnosticsError(code: string): AppError {
  switch (code) {
    case 'NOT_ENROLLED':
      return AppError.conflict(
        code,
        'This PC is not linked to support yet. It is linked when the licence is activated.',
      );
    case 'UNREACHABLE':
      return new AppError(
        503,
        'SUPPORT_UNREACHABLE',
        'Support could not be reached. Check the internet connection and try again; the restaurant keeps working meanwhile.',
      );
    default:
      return new AppError(
        502,
        'SUPPORT_REFUSED',
        `Support did not accept the report (${code}). Call support and quote this code.`,
        { reason: code },
      );
  }
}

/**
 * The System page (P4-04b, MGR-010): the single support screen (NFR-I03) with versions, service
 * status, devices, storage (DATA-006), backups, the licence and updates; "Install now" (UPD-004)
 * and "Send diagnostics to support" (UPD-008).
 */
@Injectable()
export class SystemService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly heartbeat: HeartbeatService,
    private readonly pagers: PagerBroker,
    private readonly devices: DevicesService,
    private readonly printerStatus: PrinterStatusService,
    private readonly storage: StorageUsage,
  ) {}

  async view(principal: Principal): Promise<SystemView> {
    const restaurantId = principal.restaurantId;
    const [database, postgres, settings, drive, categories, devices, printers, queued, enrolment] =
      await Promise.all([
        this.prisma.ping(),
        this.postgresVersion(),
        this.settings.snapshot(restaurantId),
        readDataDrive(this.config.dataDir),
        this.storage.categories(),
        this.devices.list(principal),
        this.prisma.printer.findMany({
          where: { restaurantId, archivedAt: null },
          select: { offlineSince: true },
        }),
        this.printerStatus.queuedByPrinter(this.prisma, restaurantId),
        readEnrolment(this.prisma),
      ]);
    const levels = {
      warnPercent: settings.get('storage.warnPercent'),
      criticalPercent: settings.get('storage.criticalPercent'),
    };
    const usedPercent =
      drive === null || drive.totalBytes <= 0
        ? null
        : usedPercentOf(drive.totalBytes, drive.freeBytes);
    const link = this.heartbeat.status();
    const paired = devices.devices.filter((device) => device.status === 'ACTIVE');
    return {
      checkedAt: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      versions: {
        product: this.productVersion(),
        server: SERVER_PACKAGE.version,
        node: process.versions.node,
        postgres,
        buildId: this.config.buildId ?? null,
      },
      services: {
        database,
        pagerBroker: this.pagers.status(),
        printers: {
          total: printers.length,
          offline: printers.filter((printer) => printer.offlineSince !== null).length,
          waiting: [...queued.values()].reduce((sum, count) => sum + count, 0),
        },
        controlPlane: {
          configured: link.configured,
          enrolled: enrolment !== undefined,
          lastReportAt: link.lastSuccessAt?.toISOString() ?? null,
          // A report that found no enrolment says nothing once this PC is enrolled.
          lastError:
            enrolment !== undefined && link.lastError === 'NOT_ENROLLED' ? null : link.lastError,
        },
      },
      devices: DeviceType.options
        .map((type) => {
          const ofType = paired.filter((device) => device.type === type);
          return {
            type,
            paired: ofType.length,
            connected: ofType.filter((device) => device.online).length,
          };
        })
        .filter((group) => group.paired > 0),
      storage: {
        totalBytes: drive?.totalBytes ?? null,
        freeBytes: drive?.freeBytes ?? null,
        usedPercent,
        ...levels,
        level: usedPercent === null ? null : storageLevelOf(usedPercent, levels),
        categories,
      },
      backups: {
        walMode: settings.get('backups.walMode'),
        secondLocation: settings.get('backups.secondLocation'),
        keepDaily: settings.get('backups.keepDaily'),
        keepWeekly: settings.get('backups.keepWeekly'),
        cloudEnabled: settings.get('backups.cloudEnabled'),
        // Backups run from P7-05.
        lastBackupAt: null,
      },
      // The licence arrives with activation (P7-01).
      licence: null,
      updates: await this.updates(this.prisma, restaurantId),
    };
  }

  /**
   * "Install now" (UPD-004): records a manager's approval of the offered release for the update
   * agent (P7-04), audited. Refused while tables are open, unless the release is security-critical
   * and the manager says why; approving the same release again changes nothing. A table opened
   * after the approval does not undo it: the update agent checks again before it installs.
   */
  async installNow(principal: Principal, request: InstallNowRequest): Promise<SystemUpdates> {
    return this.prisma.transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${ADVISORY_LOCKS.installApproval})`;
      // One query at a time: a transaction has one connection.
      const release = await readOfferedUpdate(tx);
      const openTables = await this.openTables(tx);
      const previous = await readInstallApproval(tx);
      const offered = release === null ? null : offeredUpdateOf(release);
      const refused = installNowRefusal({
        offered,
        version: request.version,
        openTables,
        reason: request.reason,
      });
      if (refused !== null) throw refusal(refused, openTables);
      if (previous?.version !== request.version) {
        const approver = await tx.staff.findUniqueOrThrow({
          where: { id: principal.staffId },
          select: { displayName: true },
        });
        const approval: InstallApproval = {
          version: request.version,
          approvedAt: new Date().toISOString(),
          approvedBy: { id: principal.staffId, name: approver.displayName },
          reason: request.reason ?? null,
        };
        await saveInstallApproval(tx, approval);
        await this.audit.record(tx, {
          action: 'UPDATE_INSTALL_APPROVED',
          entityType: 'software_update',
          actorId: principal.staffId,
          deviceId: principal.deviceId,
          restaurantId: principal.restaurantId,
          before: { version: this.productVersion(), approved: previous?.version ?? null },
          after: {
            version: request.version,
            securityCritical: offered?.securityCritical ?? false,
            openTables,
          },
          reason: approval.reason,
        });
      }
      return this.updates(tx, principal.restaurantId);
    });
  }

  /**
   * "Send diagnostics to support" (UPD-008): the health report goes to the Control Plane now
   * rather than at the next heartbeat; audited once it arrived (UPD-009). The log bundle with
   * configuration and the device list arrives with P7-08.
   */
  async sendDiagnostics(principal: Principal): Promise<DiagnosticsResponse> {
    const status = await this.heartbeat.beat();
    if (!status.configured) {
      throw AppError.conflict(
        'SUPPORT_NOT_SET_UP',
        'This PC has no support link set up. The installer sets it up; call support for help.',
      );
    }
    if (status.lastError !== null || status.lastSuccessAt === null) {
      throw diagnosticsError(status.lastError ?? 'UNREACHABLE');
    }
    const sentAt = status.lastSuccessAt.toISOString();
    await this.prisma.transaction((tx) =>
      this.audit.record(tx, {
        action: 'DIAGNOSTICS_SENT',
        entityType: 'diagnostics',
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        after: { sentAt, installationId: status.installationId },
      }),
    );
    return { sentAt };
  }

  /** What is installed and offered, the window, the approval and the open tables (UPD-004). */
  private async updates(client: Client, restaurantId: string): Promise<SystemUpdates> {
    // One query at a time: inside "Install now" this runs on the transaction's one connection.
    const settings = await this.settings.snapshot(restaurantId);
    const release = await readOfferedUpdate(client);
    const approval = await readInstallApproval(client);
    const enrolment = await readEnrolment(client);
    const openTables = await this.openTables(client);
    const offered = release === null ? null : offeredUpdateOf(release);
    return {
      current: this.productVersion(),
      channel: enrolment?.channel ?? null,
      offered,
      maintenanceWindow: settings.get('updates.maintenanceWindow'),
      // An approval counts only for the release offered now.
      approval: approval !== null && approval.version === offered?.version ? approval : null,
      openTables,
    };
  }

  /** Every open table on this PC: an update restarts the server for all of them. */
  private openTables(client: Client): Promise<number> {
    return client.tableSession.count({ where: { status: 'OPEN' } });
  }

  private productVersion(): string {
    return this.config.productVersion ?? SERVER_PACKAGE.version;
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
