import type { ActivationCodeView, VendorInstallationView } from '@rp/contracts/control-plane';
import { Badge, Button, Card, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { whenOrDash } from '../app/format.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useApi, useMay } from '../app/services.js';
import { useLoad } from '../app/use-load.js';
import { LoadView } from '../components/LoadView.js';
import { InstallationHealth } from '../fleet/InstallationHealth.js';
import { RemoteSettingsCard } from '../remote/RemoteSettingsCard.js';
import { DiagnosticsCard } from './DiagnosticsCard.js';
import { Page } from '../components/Page.js';
import { ReasonDialog } from '../components/ReasonDialog.js';
import { ActivationCodeDialog, INSTALLATION_TONE } from './InstallationsPanel.js';
import { LicenceCard } from './LicenceCard.js';

function Facts({ installation }: { installation: VendorInstallationView }) {
  const t = useT();
  return (
    <dl className="cp-facts">
      <div className="cp-facts__row">
        <dt>{t('vendorApp.installation.status')}</dt>
        <dd>
          <Badge tone={INSTALLATION_TONE[installation.status]}>
            {t(`vendorApp.installation.state.${installation.status}`)}
          </Badge>
        </dd>
      </div>
      <div className="cp-facts__row">
        <dt>{t('vendorApp.installation.channel')}</dt>
        <dd>{t(`vendorApp.channel.${installation.channel}`)}</dd>
      </div>
      <div className="cp-facts__row">
        <dt>{t('vendorApp.installation.version')}</dt>
        <dd>{installation.version ?? '—'}</dd>
      </div>
      <div className="cp-facts__row">
        <dt>{t('vendorApp.installation.enrolledAt')}</dt>
        <dd>{whenOrDash(installation.enrolledAt)}</dd>
      </div>
      <div className="cp-facts__row">
        <dt>{t('vendorApp.installation.lastSeen')}</dt>
        <dd>{whenOrDash(installation.lastSeenAt)}</dd>
      </div>
    </dl>
  );
}

/**
 * One restaurant PC (VCP-002): a new activation code while it is not activated, moving it to a
 * new PC, disconnecting it for good, and its licence.
 */
export function InstallationScreen() {
  const t = useT();
  const api = useApi();
  const may = useMay();
  const toast = useToast();
  const id = useParams().id ?? '';
  const { data, reload } = useLoad(
    (signal) => api.getVendorInstallation({ params: { id }, signal }),
    `installation:${id}`,
  );
  const [code, setCode] = useState<ActivationCodeView | undefined>();
  const [open, setOpen] = useState<'move' | 'revoke' | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const close = () => {
    setOpen(undefined);
  };

  return (
    <LoadView data={data} reload={reload} failed={t('vendorApp.installation.loadFailed')}>
      {(installation) => (
        <Page
          back={
            <Link className="cp-link cp-back" to={`/restaurants/${installation.tenantId}`}>
              {t('vendorApp.installation.back')}
            </Link>
          }
          title={installation.name}
          actions={
            <>
              {may('TENANTS_MANAGE') && installation.status === 'PENDING' ? (
                <Button
                  variant="secondary"
                  loading={busy}
                  onClick={() => {
                    setBusy(true);
                    setError(undefined);
                    api.issueActivationCode({ params: { id } }).then(
                      (issued) => {
                        setBusy(false);
                        setCode(issued);
                      },
                      (failure: unknown) => {
                        setBusy(false);
                        setError(messageOf(failure, t));
                      },
                    );
                  }}
                >
                  {t('vendorApp.installation.newCode')}
                </Button>
              ) : null}
              {may('LICENCE_REBIND') && installation.status === 'ACTIVE' ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setOpen('move');
                  }}
                >
                  {t('vendorApp.installation.move')}
                </Button>
              ) : null}
              {may('TENANTS_MANAGE') && installation.status !== 'REVOKED' ? (
                <Button
                  variant="danger"
                  onClick={() => {
                    setOpen('revoke');
                  }}
                >
                  {t('vendorApp.installation.revoke')}
                </Button>
              ) : null}
            </>
          }
        >
          {error === undefined ? null : (
            <p role="alert" className="cp-notice cp-notice--danger">
              {error}
            </p>
          )}
          <div className="cp-columns">
            <Card title={t('vendorApp.installation.title')} headingLevel={2}>
              <Facts installation={installation} />
            </Card>
            <LicenceCard installationId={installation.id} />
            <InstallationHealth installationId={installation.id} />
            <DiagnosticsCard installationId={installation.id} />
            <RemoteSettingsCard installationId={installation.id} />
          </div>
          <ActivationCodeDialog
            code={code}
            onClose={() => {
              setCode(undefined);
              reload();
            }}
          />
          <ReasonDialog
            open={open === 'move'}
            title={t('vendorApp.installation.moveTitle')}
            description={t('vendorApp.installation.moveIntro')}
            confirmLabel={t('vendorApp.installation.move')}
            onClose={close}
            onConfirm={async (reason) => {
              const issued = await api.moveInstallation({ params: { id }, body: { reason } });
              close();
              setCode(issued);
            }}
          />
          <ReasonDialog
            open={open === 'revoke'}
            title={t('vendorApp.installation.revokeTitle')}
            description={t('vendorApp.installation.revokeWarning')}
            confirmLabel={t('vendorApp.installation.revoke')}
            tone="danger"
            onClose={close}
            onConfirm={async (reason) => {
              await api.revokeVendorInstallation({ params: { id }, body: { reason } });
              close();
              toast.show({ title: t('vendorApp.installation.revoked'), tone: 'success' });
              reload();
            }}
          />
        </Page>
      )}
    </LoadView>
  );
}
