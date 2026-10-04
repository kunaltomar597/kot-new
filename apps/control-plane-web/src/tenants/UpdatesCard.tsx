import type { VendorInstallationView } from '@rp/contracts/control-plane';
import { Button, Card, TextField, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { useT } from '../app/i18n.js';
import { useApi, useMay } from '../app/services.js';
import { ReasonDialog } from '../components/ReasonDialog.js';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/**
 * A PC's updates (UPD-002): what it runs, and whether the vendor holds it at a version. The Super
 * Admin holds it, or lets it follow its channel again; both audited with a reason.
 */
export function UpdatesCard({
  installation,
  onChanged,
}: {
  installation: VendorInstallationView;
  onChanged: () => void;
}) {
  const t = useT();
  const api = useApi();
  const may = useMay();
  const toast = useToast();
  const [dialog, setDialog] = useState<'hold' | 'release' | undefined>();
  const [version, setVersion] = useState('');
  const valid = SEMVER.test(version.trim());
  const save = async (pinned: string | null, reason: string) => {
    await api.pinVendorInstallation({
      params: { id: installation.id },
      body: { version: pinned, reason },
    });
    setDialog(undefined);
    toast.show({
      title:
        pinned === null
          ? t('vendorApp.updates.released')
          : t('vendorApp.updates.held', { version: pinned }),
      tone: 'success',
    });
    onChanged();
  };
  return (
    <Card title={t('vendorApp.updates.title')} headingLevel={2}>
      <p>
        {installation.pinnedVersion === null
          ? t('vendorApp.updates.follows', {
              channel: t(`vendorApp.channel.${installation.channel}`),
            })
          : t('vendorApp.updates.heldAt', { version: installation.pinnedVersion })}
      </p>
      {may('RELEASES_MANAGE') ? (
        <div className="cp-actions">
          <Button
            variant="secondary"
            onClick={() => {
              setVersion(installation.pinnedVersion ?? installation.version ?? '');
              setDialog('hold');
            }}
          >
            {t('vendorApp.updates.hold')}
          </Button>
          {installation.pinnedVersion === null ? null : (
            <Button
              variant="ghost"
              onClick={() => {
                setDialog('release');
              }}
            >
              {t('vendorApp.updates.release')}
            </Button>
          )}
        </div>
      ) : null}
      <ReasonDialog
        open={dialog === 'hold'}
        title={t('vendorApp.updates.holdTitle', { pc: installation.name })}
        description={t('vendorApp.updates.holdIntro')}
        confirmLabel={t('vendorApp.updates.hold')}
        onClose={() => {
          setDialog(undefined);
        }}
        onConfirm={async (reason) => {
          if (!valid) throw new Error(t('vendorApp.updates.versionInvalid'));
          await save(version.trim(), reason);
        }}
      >
        <TextField
          label={t('vendorApp.updates.version')}
          hint={t('vendorApp.releases.versionHint')}
          value={version}
          error={version.trim() === '' || valid ? undefined : t('vendorApp.updates.versionInvalid')}
          onChange={(event) => {
            setVersion(event.target.value);
          }}
        />
      </ReasonDialog>
      <ReasonDialog
        open={dialog === 'release'}
        title={t('vendorApp.updates.releaseTitle', { pc: installation.name })}
        description={t('vendorApp.updates.releaseIntro')}
        confirmLabel={t('vendorApp.updates.release')}
        onClose={() => {
          setDialog(undefined);
        }}
        onConfirm={async (reason) => {
          await save(null, reason);
        }}
      />
    </Card>
  );
}
