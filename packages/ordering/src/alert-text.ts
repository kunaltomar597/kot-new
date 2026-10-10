import type { AlertView } from '@rp/contracts';
import type { Translator } from '@rp/i18n';
import { minutesSince } from './floor-view.js';

/** What an alert says on a screen (P2-06a; the POS alert centre uses it too, P2-06c). */
export interface AlertText {
  /** Where and what, like the pager's "T5 READY": "Table 5 · Food ready", or a manager's message. */
  readonly title: string;
  /** The detail under it, e.g. the dishes waiting; null when there is none. */
  readonly detail: string | null;
}

const textOf = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

const numberOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const namesOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : [];

/**
 * The words for an alert: where it is and what it asks for, then the detail its payload carries
 * (the dishes, the order, who asked). A manager's nudge shows their message and name (NTF-008).
 */
export function describeAlert(alert: AlertView, t: Translator): AlertText {
  if (alert.type === 'MANAGER_NUDGE') {
    return {
      title: textOf(alert.payload.message) ?? t('alerts.type.MANAGER_NUDGE'),
      detail: alert.raisedByName === null ? null : t('alerts.from', { name: alert.raisedByName }),
    };
  }
  const what =
    alert.type === 'DEVICE_LOW_BATTERY_OR_OFFLINE'
      ? t(alert.payload.online === false ? 'alerts.offline' : 'alerts.lowBattery')
      : t(`alerts.type.${alert.type}`);
  return { title: placed(alert, what, t), detail: detailOf(alert, t) };
}

/** The table first, or a takeaway's token, as the kitchen and the pager name them. */
function placed(alert: AlertView, what: string, t: Translator): string {
  if (alert.tableLabel !== null) return t('alerts.atTable', { table: alert.tableLabel, what });
  const token = numberOf(alert.payload.takeawayToken);
  return token === null ? what : t('alerts.atToken', { token, what });
}

function detailOf(alert: AlertView, t: Translator): string | null {
  const { payload } = alert;
  switch (alert.type) {
    case 'ITEM_READY': {
      const items = namesOf(payload.items);
      return items.length === 0 ? null : items.join(', ');
    }
    case 'READY_NOT_COLLECTED': {
      const items = namesOf(payload.items).join(', ');
      const kot = numberOf(payload.kotNumber);
      if (kot === null) return items === '' ? null : items;
      return t('alerts.kot', { number: kot, items });
    }
    case 'ORDER_PENDING_APPROVAL': {
      const order = numberOf(payload.orderNumber);
      if (order === null) return null;
      return t('alerts.orderFrom', { number: order, source: textOf(payload.source) ?? 'POS' });
    }
    case 'BILL_REQUEST': {
      const source = textOf(payload.requestedFrom);
      return source === null ? null : t('alerts.billFrom', { source });
    }
    case 'DEVICE_LOW_BATTERY_OR_OFFLINE': {
      const device =
        textOf(payload.deviceName) ??
        t('alerts.device', { type: textOf(payload.deviceType) ?? 'OTHER' });
      if (payload.online === false) return t('alerts.deviceOffline', { device });
      const percent = numberOf(payload.batteryPercent);
      return percent === null ? null : t('alerts.deviceBattery', { device, percent });
    }
    case 'PRINTER_OFFLINE': {
      const printer = textOf(payload.printerName);
      if (printer === null) return null;
      const error = textOf(payload.error);
      const queued = numberOf(payload.queued) ?? 0;
      const why =
        error === null
          ? t('alerts.printerDown', { printer })
          : t('alerts.printerError', { printer, error });
      return queued > 0 ? `${why} ${t('alerts.printerQueued', { count: queued })}` : why;
    }
    case 'DISK_OR_BACKUP': {
      const percent = numberOf(payload.usedPercent);
      const free = numberOf(payload.freeBytes);
      if (percent === null || free === null) return null;
      return t('alerts.diskFull', { percent, free: sizeText(free, t) });
    }
    default:
      return null;
  }
}

const SIZE_UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * A size in bytes as Windows Explorer shows it, in units of 1,024: "850 MB", "12.4 GB" (one
 * decimal below 100 of a unit).
 */
export function sizeText(bytes: number, t: Translator): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1_024 && unit < SIZE_UNITS.length - 1) {
    value /= 1_024;
    unit += 1;
  }
  const rounded = unit === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return t('ui.size', { value: String(rounded), unit: SIZE_UNITS[unit] ?? 'TB' });
}

/** "Just now", "4 min ago", "1 h 05 min ago": how long an alert has waited (clocks drift). */
export function alertAge(createdAt: string, now: number, t: Translator): string {
  const minutes = minutesSince(createdAt, now);
  if (minutes < 60) return t('alerts.age', { minutes });
  return t('alerts.ageHours', {
    hours: Math.floor(minutes / 60),
    minutes: String(minutes % 60).padStart(2, '0'),
  });
}
