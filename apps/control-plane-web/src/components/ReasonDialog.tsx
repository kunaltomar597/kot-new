import { Button, Dialog, TextField } from '@rp/ui-web';
import { type ReactNode, useState } from 'react';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';

/**
 * Asks why before an action that is audited with a reason (SEC-018): revoking, moving, re-binding.
 * Stays open with the error when the Control Plane refuses.
 */
export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel,
  tone = 'primary',
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
  children?: ReactNode;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const close = () => {
    setReason('');
    setError(undefined);
    onClose();
  };
  const valid = reason.trim().length >= 3;
  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t('vendorApp.actions.cancel')}
          </Button>
          <Button
            variant={tone}
            loading={busy}
            disabled={!valid || busy}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              onConfirm(reason.trim()).then(
                () => {
                  setBusy(false);
                  setReason('');
                },
                (failure: unknown) => {
                  setBusy(false);
                  setError(messageOf(failure, t));
                },
              );
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      <TextField
        label={t('vendorApp.reason.label')}
        hint={t('vendorApp.reason.hint')}
        value={reason}
        maxLength={200}
        onChange={(event) => {
          setReason(event.target.value);
        }}
      />
      {error === undefined ? null : (
        <p role="alert" className="cp-notice cp-notice--danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}
