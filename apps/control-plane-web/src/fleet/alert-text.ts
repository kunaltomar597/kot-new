import type { FleetAlertView } from '@rp/contracts/control-plane';
import type { Translator } from '@rp/i18n';

const numberOf = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined;

/** What an alert saw, in a sentence (VCP-005, AUD-003). */
export function alertDetail(alert: FleetAlertView, t: Translator): string {
  const details = alert.details ?? {};
  switch (alert.kind) {
    case 'OFFLINE':
      return t('vendorApp.fleet.detail.offline', { minutes: numberOf(details.minutes) ?? 0 });
    case 'DISK_FULL':
      return t('vendorApp.fleet.detail.disk', { percent: numberOf(details.usedPercent) ?? 0 });
    case 'BACKUP_FAILED':
      return typeof details.error === 'string'
        ? t('vendorApp.fleet.detail.backupWithError', { error: details.error })
        : t('vendorApp.fleet.detail.backup');
    case 'AUDIT_CHAIN_MISMATCH': {
      const sequence = numberOf(details.sequence) ?? 0;
      const text =
        details.reason === 'REWRITTEN'
          ? t('vendorApp.fleet.detail.rewritten', { sequence })
          : details.reason === 'EMPTIED'
            ? t('vendorApp.fleet.detail.emptied')
            : t('vendorApp.fleet.detail.rolledBack', { sequence });
      return details.byAuditCheck === true ? t('vendorApp.fleet.detail.byCheck', { text }) : text;
    }
  }
}
