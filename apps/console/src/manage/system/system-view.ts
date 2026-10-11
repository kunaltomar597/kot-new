import type { StorageCategory, SystemView } from '@rp/contracts';
import { calendarDateOf, timeOfDayOf } from '@rp/domain';
import type { Translator } from '@rp/i18n';
import { sizeText } from '@rp/ordering';
import { DEVICE_TYPE_ORDER, shortDateOf } from '../devices/devices-view.js';

/**
 * The System page (P4-04b, MGR-010, NFR-I03) in words: how long the server has run, whether each
 * service works, the devices, the data drive and when something last happened. The server checks
 * "Install now" again; these only describe what it sent.
 */

/** Whether a service works: a badge in words, its colour only repeating them (NFR-U05). */
export type ServiceHealth = 'ok' | 'problem' | 'off';

export interface ServiceLine {
  readonly key: 'database' | 'pagers' | 'printers' | 'support';
  readonly name: string;
  readonly health: ServiceHealth;
  readonly detail: string;
}

/** "Running for 12 min", "Running for 5 h 7 min", "Running for 3 days 4 h". */
export function uptimeText(seconds: number, t: Translator): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return t('system.uptime.minutes', { minutes });
  if (hours < 24) return t('system.uptime.hours', { hours, minutes: minutes % 60 });
  return t('system.uptime.days', { days: Math.floor(hours / 24), hours: hours % 24 });
}

/** When something happened, in IST: the time today, or the day and time before today. */
export function momentText(
  at: string,
  now: Date,
  t: Translator,
  keys: {
    readonly today: 'system.services.supportToday' | 'system.backups.lastToday';
    readonly earlier: 'system.services.supportEarlier' | 'system.backups.lastEarlier';
  },
): string {
  const moment = new Date(at);
  const time = timeOfDayOf(moment);
  const date = calendarDateOf(moment);
  return date === calendarDateOf(now)
    ? t(keys.today, { time })
    : t(keys.earlier, { date: shortDateOf(date, t.locale), time });
}

/** Who approved "Install now" and when, in IST. */
export function approvalText(
  approval: NonNullable<SystemView['updates']['approval']>,
  now: Date,
  t: Translator,
): string {
  const at = new Date(approval.approvedAt);
  const time = timeOfDayOf(at);
  const date = calendarDateOf(at);
  const name = approval.approvedBy.name;
  return date === calendarDateOf(now)
    ? t('system.updates.approvedToday', { name, time })
    : t('system.updates.approvedEarlier', { name, date: shortDateOf(date, t.locale), time });
}

/** The database, the pager link, the printers and the support link, each with its state. */
export function serviceLines(view: SystemView, now: Date, t: Translator): ServiceLine[] {
  const { database, pagerBroker, printers, controlPlane } = view.services;
  let support: Pick<ServiceLine, 'health' | 'detail'>;
  if (!controlPlane.configured) {
    support = { health: 'off', detail: t('system.services.supportNotSetUp') };
  } else if (!controlPlane.enrolled) {
    support = { health: 'off', detail: t('system.services.supportNotLinked') };
  } else if (controlPlane.lastError !== null) {
    support = {
      health: 'problem',
      detail: t('system.services.supportFailed', { reason: controlPlane.lastError }),
    };
  } else if (controlPlane.lastReportAt === null) {
    support = { health: 'ok', detail: t('system.services.supportNoReport') };
  } else {
    support = {
      health: 'ok',
      detail: momentText(controlPlane.lastReportAt, now, t, {
        today: 'system.services.supportToday',
        earlier: 'system.services.supportEarlier',
      }),
    };
  }
  return [
    {
      key: 'database',
      name: t('system.services.database'),
      health: database.up ? 'ok' : 'problem',
      detail: database.up
        ? t('system.services.databaseUp', { ms: database.latencyMs })
        : t('system.services.databaseDown'),
    },
    {
      key: 'pagers',
      name: t('system.services.pagers'),
      health: pagerBroker.running ? 'ok' : 'off',
      detail:
        pagerBroker.running && pagerBroker.port !== null
          ? t('system.services.pagersOn', {
              count: pagerBroker.connectedPagers,
              port: String(pagerBroker.port),
              secure: pagerBroker.secure ? 'yes' : 'no',
            })
          : t('system.services.pagersOff'),
    },
    {
      key: 'printers',
      name: t('system.services.printers'),
      health: printers.total === 0 ? 'off' : printers.offline > 0 ? 'problem' : 'ok',
      detail:
        printers.total === 0
          ? t('system.services.printersNone')
          : printers.offline > 0
            ? t('system.services.printersOffline', {
                offline: printers.offline,
                total: printers.total,
                waiting: printers.waiting,
              })
            : t('system.services.printersOk', { total: printers.total, waiting: printers.waiting }),
    },
    { key: 'support', name: t('system.services.support'), ...support },
  ];
}

/** Paired devices by type, in the order the Devices page lists them. */
export function deviceLines(devices: SystemView['devices']): SystemView['devices'] {
  return [...devices].sort(
    (a, b) => DEVICE_TYPE_ORDER.indexOf(a.type) - DEVICE_TYPE_ORDER.indexOf(b.type),
  );
}

/** "The data drive is 86% full, with 12.4 GB free of 100 GB.", or that it could not be read. */
export function driveText(storage: SystemView['storage'], t: Translator): string {
  if (storage.usedPercent === null || storage.totalBytes === null || storage.freeBytes === null) {
    return t('system.storage.unreadable');
  }
  return t('system.storage.drive', {
    percent: storage.usedPercent,
    free: sizeText(storage.freeBytes, t),
    total: sizeText(storage.totalBytes, t),
  });
}

/** A category's size in words, or that it could not be measured. */
export function categorySize(bytes: number | null, t: Translator): string {
  return bytes === null ? t('system.storage.notMeasured') : sizeText(bytes, t);
}

export const STORAGE_CATEGORY_KEYS: Readonly<
  Record<StorageCategory, `system.storage.category.${StorageCategory}`>
> = {
  TRANSACTIONS: 'system.storage.category.TRANSACTIONS',
  AUDIT: 'system.storage.category.AUDIT',
  PHOTOS: 'system.storage.category.PHOTOS',
  LOGS: 'system.storage.category.LOGS',
  BACKUPS: 'system.storage.category.BACKUPS',
};

/**
 * What "Install now" can do with the offered release now (UPD-004): nothing offered, install,
 * wait for the tables, or install a security update through them with a reason.
 */
export type InstallChoice =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'APPROVED' }
  | { readonly kind: 'INSTALL'; readonly needsReason: boolean }
  | { readonly kind: 'WAIT_FOR_TABLES' };

export function installChoiceOf(updates: SystemView['updates']): InstallChoice {
  const { offered, approval, openTables } = updates;
  if (offered === null) return { kind: 'NONE' };
  if (approval !== null) return { kind: 'APPROVED' };
  if (openTables === 0) return { kind: 'INSTALL', needsReason: false };
  return offered.securityCritical
    ? { kind: 'INSTALL', needsReason: true }
    : { kind: 'WAIT_FOR_TABLES' };
}
