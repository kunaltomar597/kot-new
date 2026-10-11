import {
  type ActivationCodeView,
  RELEASE_CHANNELS,
  type ReleaseChannel,
  type VendorTenantDetail,
} from '@rp/contracts/control-plane';
import { Badge, Button, Dialog, Select, Table, TextField } from '@rp/ui-web';
import { useState } from 'react';
import { Link } from 'react-router';
import { when, whenOrDash } from '../app/format.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useApi, useMay } from '../app/services.js';
import { LicenceBadge } from '../components/LicenceBadge.js';
import { OneTimeSecret } from '../components/OneTimeSecret.js';

export const INSTALLATION_TONE = {
  PENDING: 'info',
  ACTIVE: 'success',
  REVOKED: 'neutral',
} as const;

/** An activation code just issued, shown once with when it stops working (ONB-003). */
export function ActivationCodeDialog({
  code,
  onClose,
}: {
  code: ActivationCodeView | undefined;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Dialog
      open={code !== undefined}
      onClose={onClose}
      title={t('vendorApp.installation.codeTitle')}
      footer={<Button onClick={onClose}>{t('vendorApp.actions.done')}</Button>}
    >
      {code === undefined ? null : (
        <OneTimeSecret
          label={t('vendorApp.installation.code')}
          value={code.code}
          hint={t('vendorApp.installation.codeHint', { until: when(code.expiresAt) })}
        />
      )}
    </Dialog>
  );
}

/** The restaurant's PCs; Onboarding adds one and gets its activation code once (VCP-002). */
export function InstallationsPanel({
  tenant,
  onChange,
}: {
  tenant: VendorTenantDetail;
  onChange: () => void;
}) {
  const t = useT();
  const api = useApi();
  const may = useMay();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [channel, setChannel] = useState<ReleaseChannel>('STABLE');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [code, setCode] = useState<ActivationCodeView | undefined>();
  const close = () => {
    setAdding(false);
    setName('');
    setChannel('STABLE');
    setError(undefined);
  };

  return (
    <div className="cp-panel">
      {may('TENANTS_MANAGE') ? (
        <div className="cp-toolbar">
          <Button
            variant="secondary"
            onClick={() => {
              setAdding(true);
            }}
          >
            {t('vendorApp.installation.add')}
          </Button>
        </div>
      ) : null}
      <Table
        caption={t('vendorApp.tenant.tab.pcs')}
        hideCaption
        rows={tenant.installationList}
        rowKey={(installation) => installation.id}
        empty={t('vendorApp.installation.none')}
        columns={[
          {
            key: 'name',
            header: t('vendorApp.installation.name'),
            cell: (installation) => (
              <Link className="cp-link" to={`/installations/${installation.id}`}>
                {installation.name}
              </Link>
            ),
          },
          {
            key: 'status',
            header: t('vendorApp.installation.status'),
            cell: (installation) => (
              <Badge tone={INSTALLATION_TONE[installation.status]}>
                {t(`vendorApp.installation.state.${installation.status}`)}
              </Badge>
            ),
          },
          {
            key: 'channel',
            header: t('vendorApp.installation.channel'),
            cell: (installation) => t(`vendorApp.channel.${installation.channel}`),
          },
          {
            key: 'version',
            header: t('vendorApp.installation.version'),
            cell: (installation) => installation.version ?? '—',
          },
          {
            key: 'seen',
            header: t('vendorApp.installation.lastSeen'),
            cell: (installation) => whenOrDash(installation.lastSeenAt),
          },
          {
            key: 'licence',
            header: t('vendorApp.tenants.licence'),
            cell: (installation) => <LicenceBadge state={installation.licenceState} />,
          },
        ]}
      />
      <Dialog
        open={adding}
        onClose={close}
        title={t('vendorApp.installation.addTitle')}
        description={t('vendorApp.installation.addIntro')}
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              {t('vendorApp.actions.cancel')}
            </Button>
            <Button
              loading={busy}
              disabled={busy || name.trim() === ''}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                api
                  .createVendorInstallation({
                    params: { id: tenant.id },
                    body: { name: name.trim(), channel },
                  })
                  .then(
                    (issued) => {
                      setBusy(false);
                      close();
                      setCode(issued);
                      onChange();
                    },
                    (failure: unknown) => {
                      setBusy(false);
                      setError(messageOf(failure, t));
                    },
                  );
              }}
            >
              {t('vendorApp.installation.create')}
            </Button>
          </>
        }
      >
        <TextField
          label={t('vendorApp.installation.name')}
          hint={t('vendorApp.installation.nameHint')}
          value={name}
          maxLength={120}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <Select
          label={t('vendorApp.installation.channel')}
          value={channel}
          options={RELEASE_CHANNELS.map((value) => ({
            value,
            label: t(`vendorApp.channel.${value}`),
          }))}
          onChange={(event) => {
            setChannel(event.target.value as ReleaseChannel);
          }}
        />
        {error === undefined ? null : (
          <p role="alert" className="cp-notice cp-notice--danger">
            {error}
          </p>
        )}
      </Dialog>
      <ActivationCodeDialog
        code={code}
        onClose={() => {
          setCode(undefined);
        }}
      />
    </div>
  );
}
