import type { FleetAlertView } from '@rp/contracts/control-plane';
import { Badge, Button, Table, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { Link } from 'react-router';
import { when } from '../app/format.js';
import { useT } from '../app/i18n.js';
import { useApi, useMay } from '../app/services.js';
import { ReasonDialog } from '../components/ReasonDialog.js';
import { alertDetail } from './alert-text.js';

export const ALERT_TONE = {
  OFFLINE: 'danger',
  DISK_FULL: 'warning',
  BACKUP_FAILED: 'warning',
  AUDIT_CHAIN_MISMATCH: 'danger',
  UPDATE_FAILED: 'warning',
} as const;

/**
 * Fleet alerts (VCP-005): when, where, what was seen and, once closed, by whom. An audit chain
 * alert is closed by a person with a reason (AUD-003); the others close by themselves.
 */
export function AlertsTable({
  alerts,
  caption,
  empty,
  showPlace = true,
  onResolved,
}: {
  alerts: readonly FleetAlertView[];
  caption: string;
  empty: string;
  showPlace?: boolean;
  onResolved: () => void;
}) {
  const t = useT();
  const api = useApi();
  const may = useMay();
  const toast = useToast();
  const [closing, setClosing] = useState<FleetAlertView | undefined>();

  return (
    <>
      <Table
        caption={caption}
        hideCaption
        rows={alerts}
        rowKey={(alert) => alert.id}
        empty={empty}
        columns={[
          {
            key: 'opened',
            header: t('vendorApp.fleet.openedAt'),
            cell: (alert) => when(alert.openedAt),
          },
          ...(showPlace
            ? [
                {
                  key: 'where',
                  header: t('vendorApp.fleet.where'),
                  cell: (alert: FleetAlertView) => (
                    <Link className="cp-link" to={`/installations/${alert.installationId}`}>
                      {t('vendorApp.fleet.place', {
                        tenant: alert.tenantName,
                        pc: alert.installationName,
                      })}
                    </Link>
                  ),
                },
              ]
            : []),
          {
            key: 'kind',
            header: t('vendorApp.fleet.alert'),
            cell: (alert) => (
              <Badge tone={ALERT_TONE[alert.kind]}>{t(`vendorApp.fleet.kind.${alert.kind}`)}</Badge>
            ),
          },
          {
            key: 'detail',
            header: t('vendorApp.fleet.seen'),
            cell: (alert) => alertDetail(alert, t),
          },
          {
            key: 'state',
            header: t('vendorApp.fleet.state'),
            cell: (alert) =>
              alert.resolvedAt === null ? (
                (alert.kind === 'AUDIT_CHAIN_MISMATCH' || alert.kind === 'UPDATE_FAILED') &&
                may('SUPPORT_NOTES') ? (
                  <Button
                    variant="secondary"
                    aria-label={t(
                      alert.kind === 'UPDATE_FAILED'
                        ? 'vendorApp.fleet.closeUpdateFor'
                        : 'vendorApp.fleet.closeFor',
                      { pc: alert.installationName },
                    )}
                    onClick={() => {
                      setClosing(alert);
                    }}
                  >
                    {t('vendorApp.fleet.close')}
                  </Button>
                ) : (
                  t('vendorApp.fleet.open')
                )
              ) : alert.resolution === null ? (
                t('vendorApp.fleet.closedAt', { at: when(alert.resolvedAt) })
              ) : (
                t('vendorApp.fleet.closedWith', {
                  at: when(alert.resolvedAt),
                  reason: alert.resolution,
                })
              ),
          },
        ]}
      />
      <ReasonDialog
        open={closing !== undefined}
        title={t(
          closing?.kind === 'UPDATE_FAILED'
            ? 'vendorApp.fleet.closeUpdateTitle'
            : 'vendorApp.fleet.closeTitle',
        )}
        description={t(
          closing?.kind === 'UPDATE_FAILED'
            ? 'vendorApp.fleet.closeUpdateIntro'
            : 'vendorApp.fleet.closeIntro',
        )}
        confirmLabel={t('vendorApp.fleet.close')}
        onClose={() => {
          setClosing(undefined);
        }}
        onConfirm={async (reason) => {
          await api.resolveFleetAlert({ params: { id: closing?.id ?? '' }, body: { reason } });
          setClosing(undefined);
          toast.show({ title: t('vendorApp.fleet.closed'), tone: 'success' });
          onResolved();
        }}
      />
    </>
  );
}
