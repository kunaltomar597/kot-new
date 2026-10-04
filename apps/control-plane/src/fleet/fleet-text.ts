import type { FleetAlertView } from '@rp/contracts/control-plane';

/** One line for a chat channel about an alert opening or closing (VCP-005). */
export function alertText(alert: FleetAlertView): string {
  const where = `${alert.tenantName}, ${alert.installationName}`;
  const details = alert.details ?? {};
  const shown = (value: unknown) =>
    typeof value === 'string' || typeof value === 'number' ? String(value) : '?';
  if (alert.resolvedAt !== null) {
    return alert.kind === 'AUDIT_CHAIN_MISMATCH'
      ? `Resolved: ${where}: audit chain alert closed by ${alert.resolvedBy ?? 'someone'} (${alert.resolution ?? ''}).`
      : `Resolved: ${where}: ${RESOLVED[alert.kind]}.`;
  }
  switch (alert.kind) {
    case 'OFFLINE':
      return `${where}: offline for ${shown(details.minutes)} minutes during business hours.`;
    case 'DISK_FULL':
      return `${where}: data drive ${shown(details.usedPercent)} % full.`;
    case 'BACKUP_FAILED':
      return `${where}: the latest backup failed${typeof details.error === 'string' ? `: ${details.error}` : ''}.`;
    case 'AUDIT_CHAIN_MISMATCH':
      return `${where}: the local audit log no longer matches what it reported (${shown(details.reason)} at entry ${shown(details.sequence)}). Look into it before closing.`;
    case 'UPDATE_FAILED':
      return `${where}: the update to ${shown(details.version)} ${UPDATE_OUTCOME[String(details.outcome)] ?? 'failed'}${typeof details.error === 'string' ? `: ${details.error}` : ''}.`;
  }
}

const RESOLVED = {
  OFFLINE: 'back online',
  DISK_FULL: 'disk use back below the threshold',
  BACKUP_FAILED: 'a backup succeeded',
  AUDIT_CHAIN_MISMATCH: 'closed',
  UPDATE_FAILED: 'the PC runs that version now',
} as const;

const UPDATE_OUTCOME: Readonly<Record<string, string>> = {
  ROLLED_BACK: 'failed its health check and was rolled back',
  FAILED: 'did not start',
  SILENT: 'went silent after it started installing',
};
