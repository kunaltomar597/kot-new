import type { FleetAlertView } from '@rp/contracts/control-plane';
import type { Translator } from '@rp/i18n';

const numberOf = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined;

/** What a PC reports as tampering, and a code the vendor never issued (LIC-007, SEC-015). */
const TAMPERING = [
  'LICENCE_TAMPERED',
  'RECORD_TAMPERED',
  'OTHER_PC',
  'CLOCK_ROLLBACK',
  'CLOCK_SKEW',
  'REACTIVATION_CODE_NOT_ISSUED',
] as const;
type Tampering = (typeof TAMPERING)[number];
const isTampering = (value: unknown): value is Tampering =>
  (TAMPERING as readonly unknown[]).includes(value);

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
    case 'UPDATE_FAILED': {
      const version = typeof details.version === 'string' ? details.version : '?';
      const outcome =
        details.outcome === 'ROLLED_BACK' || details.outcome === 'SILENT'
          ? details.outcome
          : 'FAILED';
      const text = t(`vendorApp.fleet.detail.update.${outcome}`, { version });
      return typeof details.error === 'string'
        ? t('vendorApp.fleet.detail.updateWithError', { text, error: details.error })
        : text;
    }
    case 'LICENCE_TAMPERING': {
      const kinds = Array.isArray(details.kinds) ? details.kinds.filter(isTampering) : [];
      const list = kinds.map((kind) => t(`vendorApp.fleet.detail.tamper.${kind}`)).join(', ');
      return t('vendorApp.fleet.detail.tampering', { list });
    }
    case 'UNSIGNED_UPDATES':
      return t('vendorApp.fleet.detail.unsigned', {
        version: typeof details.version === 'string' ? details.version : '?',
      });
  }
}
