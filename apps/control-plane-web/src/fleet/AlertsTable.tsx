import type { FleetAlertKind, FleetAlertView } from '@rp/contracts/control-plane';
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
  LICENCE_TAMPERING: 'danger',
  UNSIGNED_UPDATES: 'danger',
} as const;

/** The alerts a person closes with a reason, and the words for closing each. */
const CLOSE_TEXT = {
  AUDIT_CHAIN_MISMATCH: {
    label: 'vendorApp.fleet.closeFor',
    title: 'vendorApp.fleet.closeTitle',
    intro: 'vendorApp.fleet.closeIntro',
  },
  UPDATE_FAILED: {
    label: 'vendorApp.fleet.closeUpdateFor',
    title: 'vendorApp.fleet.closeUpdateTitle',
    intro: 'vendorApp.fleet.closeUpdateIntro',
  },
  LICENCE_TAMPERING: {
    label: 'vendorApp.fleet.closeTamperingFor',
    title: 'vendorApp.fleet.closeTamperingTitle',
    intro: 'vendorApp.fleet.closeTamperingIntro',
  },
} as const;

const closeTextOf = (kind: FleetAlertKind | undefined) =>
  kind !== undefined && kind in CLOSE_TEXT
    ? CLOSE_TEXT[kind as keyof typeof CLOSE_TEXT]
    : undefined;

/**
 * Fleet alerts (VCP-005): when, where, what was seen and, once closed, by whom. An audit chain
 * alert (AUD-003), a licence tampering alert (SEC-015) and a failed update are closed by a person
 * with a reason; the others close by themselves.
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
                closeTextOf(alert.kind) !== undefined && may('SUPPORT_NOTES') ? (
                  <Button
                    variant="secondary"
                    aria-label={t(closeTextOf(alert.kind)?.label ?? 'vendorApp.fleet.closeFor', {
                      pc: alert.installationName,
                    })}
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
        title={t(closeTextOf(closing?.kind)?.title ?? 'vendorApp.fleet.closeTitle')}
        description={t(closeTextOf(closing?.kind)?.intro ?? 'vendorApp.fleet.closeIntro')}
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
