import type { RestoreCodeView } from '@rp/contracts/control-plane';
import { Button, Card, Dialog, Table, TextField } from '@rp/ui-web';
import { useState } from 'react';
import { when } from '../app/format.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useApi, useMay } from '../app/services.js';
import { useLoad } from '../app/use-load.js';
import { LoadView } from '../components/LoadView.js';

/** Megabytes, for the list. */
export function megabytes(bytes: number): string {
  return Math.max(1, Math.round(bytes / 1_024 ** 2)).toString();
}

/**
 * Asks why, and how the Owner was verified (OI-10), then shows the restore code once with what
 * the Owner does with it.
 */
function RestoreCodeDialog({
  installationId,
  onClose,
}: {
  installationId: string;
  onClose: () => void;
}) {
  const t = useT();
  const api = useApi();
  const [reason, setReason] = useState('');
  const [verification, setVerification] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [issued, setIssued] = useState<RestoreCodeView | undefined>();
  if (issued !== undefined) {
    return (
      <Dialog
        open
        onClose={onClose}
        title={t('vendorApp.cloudBackups.codeTitle')}
        description={t('vendorApp.cloudBackups.codeIntro', { until: when(issued.expiresAt) })}
        footer={<Button onClick={onClose}>{t('vendorApp.cloudBackups.done')}</Button>}
      >
        <p className="cp-code" aria-label={t('vendorApp.cloudBackups.code')}>
          {issued.code}
        </p>
        <pre className="cp-pre">{t('vendorApp.cloudBackups.command', { code: issued.code })}</pre>
      </Dialog>
    );
  }
  const valid = reason.trim().length >= 3 && verification.trim().length >= 3;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('vendorApp.cloudBackups.issue')}
      description={t('vendorApp.cloudBackups.issueIntro')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('vendorApp.actions.cancel')}
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={!valid || busy}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              api
                .issueRestoreCode({
                  params: { id: installationId },
                  body: { reason: reason.trim(), ownerVerification: verification.trim() },
                })
                .then(
                  (code) => {
                    setBusy(false);
                    setIssued(code);
                  },
                  (failure: unknown) => {
                    setBusy(false);
                    setError(messageOf(failure, t));
                  },
                );
            }}
          >
            {t('vendorApp.cloudBackups.issueConfirm')}
          </Button>
        </>
      }
    >
      <div className="cp-form">
        <TextField
          label={t('vendorApp.reason.label')}
          hint={t('vendorApp.reason.hint')}
          value={reason}
          maxLength={500}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
        <TextField
          label={t('vendorApp.cloudBackups.verification')}
          hint={t('vendorApp.cloudBackups.verificationHint')}
          value={verification}
          maxLength={500}
          onChange={(event) => {
            setVerification(event.target.value);
          }}
        />
      </div>
      {error === undefined ? null : (
        <p role="alert" className="cp-notice cp-notice--danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/**
 * A PC's backups in the cloud (DATA-003, P7-05d): when and how large; they stay encrypted. Support
 * and the Super Admin issue a restore code for a new PC once the Owner is verified (P7-05e).
 */
export function CloudBackupsCard({ installationId }: { installationId: string }) {
  const t = useT();
  const api = useApi();
  const may = useMay();
  const { data, reload } = useLoad(
    (signal) => api.listVendorCloudBackups({ params: { id: installationId }, signal }),
    `cloud-backups:${installationId}`,
  );
  const [issuing, setIssuing] = useState(false);
  return (
    <Card
      title={t('vendorApp.cloudBackups.title')}
      headingLevel={2}
      actions={
        may('BACKUP_RESTORE') ? (
          <Button
            variant="secondary"
            onClick={() => {
              setIssuing(true);
            }}
          >
            {t('vendorApp.cloudBackups.issue')}
          </Button>
        ) : undefined
      }
    >
      <p className="cp-hint">{t('vendorApp.cloudBackups.intro')}</p>
      <LoadView data={data} reload={reload} failed={t('vendorApp.cloudBackups.loadFailed')}>
        {({ backups }) => (
          <Table
            caption={t('vendorApp.cloudBackups.title')}
            hideCaption
            rows={backups}
            rowKey={(backup) => backup.id}
            empty={t('vendorApp.cloudBackups.none')}
            columns={[
              {
                key: 'made',
                header: t('vendorApp.cloudBackups.made'),
                cell: (backup) => when(backup.backupCreatedAt),
              },
              {
                key: 'size',
                header: t('vendorApp.diagnostics.size'),
                align: 'end',
                cell: (backup) =>
                  t('vendorApp.cloudBackups.mb', { size: megabytes(backup.sizeBytes) }),
              },
              {
                key: 'key',
                header: t('vendorApp.cloudBackups.key'),
                cell: (backup) => backup.keyId,
              },
            ]}
          />
        )}
      </LoadView>
      {issuing ? (
        <RestoreCodeDialog
          installationId={installationId}
          onClose={() => {
            setIssuing(false);
          }}
        />
      ) : null}
    </Card>
  );
}
