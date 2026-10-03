import type { FleetInstallationView } from '@rp/contracts/control-plane';
import { Badge } from '@rp/ui-web';
import { when, whenOrDash } from '../app/format.js';
import { useT } from '../app/i18n.js';

/** Online or not, and when the PC was last heard from. */
export function OnlineBadge({ pc }: { pc: FleetInstallationView }) {
  const t = useT();
  if (pc.status === 'PENDING')
    return <Badge tone="info">{t('vendorApp.installation.state.PENDING')}</Badge>;
  if (pc.status === 'REVOKED')
    return <Badge tone="neutral">{t('vendorApp.installation.state.REVOKED')}</Badge>;
  return pc.online ? (
    <Badge tone="success">{t('vendorApp.fleet.online')}</Badge>
  ) : (
    <Badge tone="danger">{t('vendorApp.fleet.offline')}</Badge>
  );
}

/** The latest backups: not set up yet, the last success, or a failure since. */
export function BackupText({ pc }: { pc: FleetInstallationView }) {
  const t = useT();
  const backup = pc.backup;
  if (backup === null) return <>{t('vendorApp.fleet.backupNone')}</>;
  const failed =
    backup.lastFailureAt !== null &&
    (backup.lastSuccessAt === null || backup.lastFailureAt > backup.lastSuccessAt);
  if (failed)
    return (
      <Badge tone="warning">
        {t('vendorApp.fleet.backupFailed', { at: when(backup.lastFailureAt ?? '') })}
      </Badge>
    );
  return <>{t('vendorApp.fleet.backupLast', { at: whenOrDash(backup.lastSuccessAt) })}</>;
}

/**
 * The encrypted cloud backup (DATA-003, P7-05d): opted out, failing as the PC reports it, or the
 * newest backup the Control Plane holds.
 */
export function CloudBackupText({ pc }: { pc: FleetInstallationView }) {
  const t = useT();
  const cloud = pc.backup?.cloud;
  if (cloud?.enabled === false) {
    return <Badge tone="neutral">{t('vendorApp.fleet.cloudOff')}</Badge>;
  }
  const failed =
    cloud !== undefined &&
    cloud.lastFailureAt !== null &&
    (cloud.lastSuccessAt === null || cloud.lastFailureAt > cloud.lastSuccessAt);
  if (failed) {
    return (
      <Badge tone="warning">
        {t('vendorApp.fleet.cloudFailed', { at: when(cloud.lastFailureAt ?? '') })}
      </Badge>
    );
  }
  if (pc.cloudBackupAt === null) return <>{t('vendorApp.fleet.cloudNone')}</>;
  return (
    <>
      {t('vendorApp.fleet.cloudLast', { at: when(pc.cloudBackupAt) })}{' '}
      {pc.backupKeyEscrowedAt === null
        ? t('vendorApp.fleet.keyNotEscrowed')
        : t('vendorApp.fleet.keyEscrowed')}
    </>
  );
}

/** The audit chain: whether a check has confirmed it, or an open alert says it changed. */
export function ChainText({ pc }: { pc: FleetInstallationView }) {
  const t = useT();
  if (pc.openAlerts.includes('AUDIT_CHAIN_MISMATCH')) {
    return <Badge tone="danger">{t('vendorApp.fleet.chainChanged')}</Badge>;
  }
  if (pc.auditHead === null) return <>{t('vendorApp.fleet.chainNone')}</>;
  return (
    <>
      {pc.auditHead.verifiedAt === null
        ? t('vendorApp.fleet.chainUnchecked', { sequence: pc.auditHead.sequence })
        : t('vendorApp.fleet.chainChecked', {
            sequence: pc.auditHead.sequence,
            at: when(pc.auditHead.verifiedAt),
          })}
    </>
  );
}
