import type { RelayProvisioningView } from '@rp/contracts/control-plane';
import { Badge, Button, ConfirmDialog, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { when } from '../app/format.js';
import { useT } from '../app/i18n.js';
import { isNotFound, messageOf } from '../app/messages.js';
import { useApi, useMay } from '../app/services.js';
import { useLoad } from '../app/use-load.js';
import { LoadView } from '../components/LoadView.js';

/**
 * The restaurant in the QR relay (VCP-002, VCP-008): Onboarding provisions it; its credential
 * reaches the PC with the next heartbeat. Provisioning again replaces a credential that may have
 * leaked; the old one stops working at once.
 */
export function RelayPanel({ tenantId }: { tenantId: string }) {
  const t = useT();
  const api = useApi();
  const may = useMay();
  const toast = useToast();
  const { data, reload } = useLoad(async (signal) => {
    try {
      return await api.getRelayProvisioning({ params: { id: tenantId }, signal });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }, `relay:${tenantId}`);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const provision = () => {
    setBusy(true);
    setError(undefined);
    api.provisionRelay({ params: { id: tenantId } }).then(
      () => {
        setBusy(false);
        setConfirming(false);
        toast.show({ title: t('vendorApp.relay.provisioned'), tone: 'success' });
        reload();
      },
      (failure: unknown) => {
        setBusy(false);
        setConfirming(false);
        setError(messageOf(failure, t));
      },
    );
  };

  const status = (view: RelayProvisioningView | null) => {
    if (view === null) return <p className="cp-hint">{t('vendorApp.relay.notYet')}</p>;
    return (
      <>
        <p>
          {view.delivered ? (
            <Badge tone="success">{t('vendorApp.relay.delivered')}</Badge>
          ) : (
            <Badge tone="warning">{t('vendorApp.relay.waiting')}</Badge>
          )}
        </p>
        <dl className="cp-facts">
          <div className="cp-facts__row">
            <dt>{t('vendorApp.relay.provisionedAt')}</dt>
            <dd>{when(view.provisionedAt)}</dd>
          </div>
          <div className="cp-facts__row">
            <dt>{t('vendorApp.relay.issuedAt')}</dt>
            <dd>{when(view.credentialIssuedAt)}</dd>
          </div>
          {view.deliveredAt === null ? null : (
            <div className="cp-facts__row">
              <dt>{t('vendorApp.relay.deliveredAt')}</dt>
              <dd>{when(view.deliveredAt)}</dd>
            </div>
          )}
        </dl>
      </>
    );
  };

  return (
    <div className="cp-panel">
      <p className="cp-hint">{t('vendorApp.relay.intro')}</p>
      <LoadView data={data} reload={reload} failed={t('vendorApp.relay.loadFailed')}>
        {(view) => (
          <>
            {status(view)}
            {may('TENANTS_MANAGE') ? (
              <Button
                variant={view === null ? 'primary' : 'secondary'}
                loading={busy && view === null}
                disabled={busy}
                onClick={() => {
                  if (view === null) provision();
                  else setConfirming(true);
                }}
              >
                {view === null ? t('vendorApp.relay.provision') : t('vendorApp.relay.rotate')}
              </Button>
            ) : null}
          </>
        )}
      </LoadView>
      {error === undefined ? null : (
        <p role="alert" className="cp-notice cp-notice--danger">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        title={t('vendorApp.relay.rotateTitle')}
        description={t('vendorApp.relay.rotateWarning')}
        confirmLabel={t('vendorApp.relay.rotate')}
        cancelLabel={t('vendorApp.actions.cancel')}
        tone="danger"
        busy={busy}
        onConfirm={provision}
        onCancel={() => {
          setConfirming(false);
        }}
      />
    </div>
  );
}
