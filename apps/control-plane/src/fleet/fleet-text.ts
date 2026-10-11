import type { FleetAlertView } from '@rp/contracts/control-plane';

/** One line for a chat channel about an alert opening or closing (VCP-005). */
export function alertText(alert: FleetAlertView): string {
  const where = `${alert.tenantName}, ${alert.installationName}`;
  const details = alert.details ?? {};
  const shown = (value: unknown) =>
    typeof value === 'string' || typeof value === 'number' ? String(value) : '?';
  if (alert.resolvedAt !== null) {
    return alert.kind === 'AUDIT_CHAIN_MISMATCH' || alert.kind === 'LICENCE_TAMPERING'
      ? `Resolved: ${where}: ${RESOLVED[alert.kind]} by ${alert.resolvedBy ?? 'someone'} (${alert.resolution ?? ''}).`
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
    case 'LICENCE_TAMPERING': {
      const kinds = Array.isArray(details.kinds)
        ? details.kinds.map((kind) => TAMPERING[String(kind)] ?? String(kind)).join('; ')
        : '?';
      return `${where}: the licence looks tampered with (${kinds}). Speak to the restaurant before closing.`;
    }
    case 'UNSIGNED_UPDATES':
      return `${where}: version ${shown(details.version)} is a test build that installs unsigned updates. Reinstall it with a signed release.`;
  }
}

const RESOLVED = {
  OFFLINE: 'back online',
  DISK_FULL: 'disk use back below the threshold',
  BACKUP_FAILED: 'a backup succeeded',
  AUDIT_CHAIN_MISMATCH: 'audit chain alert closed',
  UPDATE_FAILED: 'the PC runs that version now',
  LICENCE_TAMPERING: 'licence tampering alert closed',
  UNSIGNED_UPDATES: 'the PC now takes only signed updates',
} as const;

/** What each kind of tampering report means (LIC-007). */
const TAMPERING: Readonly<Record<string, string>> = {
  LICENCE_TAMPERED: 'the licence file was changed or an older one put back',
  RECORD_TAMPERED: 'the PC’s licence record was edited',
  OTHER_PC: 'the licence is on another PC',
  CODE_MODIFIED: 'the server’s program files differ from the release’s',
  CLOCK_ROLLBACK: 'the clock was set or held back, again and again',
  CLOCK_SKEW: 'the clock is far off, again and again',
  REACTIVATION_CODE_NOT_ISSUED: 'a reactivation code the vendor never issued',
};

const UPDATE_OUTCOME: Readonly<Record<string, string>> = {
  ROLLED_BACK: 'failed its health check and was rolled back',
  FAILED: 'did not start',
  SILENT: 'went silent after it started installing',
};
