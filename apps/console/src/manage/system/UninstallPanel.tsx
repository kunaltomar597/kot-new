import { displayDateTime } from '@rp/domain';
import { Button, Dialog, TextField, useToast } from '@rp/ui-web';
import { useId, useState } from 'react';
import { useConsole, useConsoleState } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { grantOf } from '../../app/modes.js';
import { SecondFactorCancelled, useSecondFactor } from '../../owner/second-factor.js';

/**
 * "Removing the software" on the System page (NFR-I02, P0-16c): uninstalling keeps the data on the
 * data drive. The Owner may allow the uninstaller to delete it for 30 minutes, with a reason and
 * their second factor; the uninstall script asks the set-up tool whether it may.
 */
export function UninstallPanel({
  allowedUntil,
  onAllowed,
}: {
  /** From the System page's status; null when deleting is not allowed. */
  allowedUntil: string | null;
  onAllowed: () => void;
}) {
  const t = useT();
  const { person } = useConsoleState();
  const owner = person !== undefined && grantOf(person, 'DATA_ADMIN') !== 'DENY';
  const [open, setOpen] = useState(false);
  const time = (iso: string) => displayDateTime(new Date(iso)).time;

  return (
    <section className="device-group" aria-labelledby="system-uninstall">
      <h3 id="system-uninstall" className="device-group__heading">
        {t('systemPage.uninstall.title')}
      </h3>
      <p className="dashboard-section__hint">{t('systemPage.uninstall.intro')}</p>
      {allowedUntil === null ? null : (
        <p className="console-notice console-notice--warning">
          {t('systemPage.uninstall.allowedUntil', { time: time(allowedUntil) })}
        </p>
      )}
      {owner ? (
        <div className="staff-header">
          <Button
            variant="secondary"
            onClick={() => {
              setOpen(true);
            }}
          >
            {t('systemPage.uninstall.open')}
          </Button>
        </div>
      ) : (
        <p className="dashboard-section__hint">{t('systemPage.uninstall.ownerOnly')}</p>
      )}
      {open ? (
        <AllowDataDeletionDialog
          onClose={() => {
            setOpen(false);
          }}
          onAllowed={() => {
            setOpen(false);
            onAllowed();
          }}
        />
      ) : null}
    </section>
  );
}

function AllowDataDeletionDialog({
  onClose,
  onAllowed,
}: {
  onClose: () => void;
  onAllowed: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { withSecondFactor, dialog } = useSecondFactor();
  const checkId = useId();
  const [reason, setReason] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const allow = () => {
    setBusy(true);
    setError(undefined);
    withSecondFactor(() =>
      controller.api.allowDataDeletion({ body: { reason: reason.trim() } }),
    ).then(
      ({ allowedUntil }) => {
        toast.show({
          title: t('systemPage.uninstall.done', {
            time: displayDateTime(new Date(allowedUntil)).time,
          }),
          tone: 'warning',
        });
        onAllowed();
      },
      (failure: unknown) => {
        setBusy(false);
        if (!(failure instanceof SecondFactorCancelled)) setError(messageOf(failure, t));
      },
    );
  };

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={t('systemPage.uninstall.dialogTitle')}
        description={t('systemPage.uninstall.dialogIntro')}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {t('systemPage.uninstall.cancel')}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={busy || !understood || reason.trim().length < 3}
              onClick={allow}
            >
              {t('systemPage.uninstall.confirm')}
            </Button>
          </>
        }
      >
        <div className="console-form">
          <TextField
            label={t('systemPage.uninstall.reason')}
            hint={t('systemPage.uninstall.reasonHint')}
            value={reason}
            maxLength={200}
            autoComplete="off"
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
          <label className="menu-toolbar__check" htmlFor={checkId}>
            <input
              id={checkId}
              type="checkbox"
              checked={understood}
              onChange={(event) => {
                setUnderstood(event.target.checked);
              }}
            />
            {t('systemPage.uninstall.understood')}
          </label>
        </div>
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
      </Dialog>
      {dialog}
    </>
  );
}
