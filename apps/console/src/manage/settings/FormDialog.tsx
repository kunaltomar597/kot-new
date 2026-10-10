import { Button, Dialog, TextField } from '@rp/ui-web';
import { type ReactNode, useId } from 'react';
import { useT } from '../../app/i18n.js';
import { reasonProblemOf } from './restaurant-view.js';

/**
 * A settings dialog's form with Cancel and a confirm button (Save unless it says otherwise), the
 * server's refusal shown above the buttons. The fields check themselves, so the browser's own
 * checks are off.
 */
export function FormDialog({
  title,
  description,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  busy: boolean;
  error: string | undefined;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useT();
  const formId = useId();
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('settings.dialog.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {confirmLabel ?? t('settings.dialog.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="console-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        {children}
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** The optional reason for the audit log (AUD-001): none, or at least 3 characters. */
export function ReasonField({
  reason,
  submitted,
  onChange,
}: {
  reason: string;
  submitted: boolean;
  onChange: (reason: string) => void;
}) {
  const t = useT();
  return (
    <TextField
      label={t('settings.dialog.reason')}
      hint={t('settings.dialog.reasonHint')}
      value={reason}
      maxLength={200}
      autoComplete="off"
      error={
        submitted && reasonProblemOf(reason) !== undefined
          ? t('settings.dialog.reasonShort')
          : undefined
      }
      onChange={(event) => {
        onChange(event.target.value);
      }}
    />
  );
}
