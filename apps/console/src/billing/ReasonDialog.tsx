import { Button, Dialog, TextField } from '@rp/ui-web';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../app/i18n.js';

/** Asks why before an audited change (a reason is mandatory, AUD-001). */
export function ReasonDialog({
  title,
  description,
  label,
  confirmLabel,
  tone = 'primary',
  onConfirm,
  onClose,
  busy = false,
  error,
}: {
  title: string;
  /** What will happen, when the title does not say it all. */
  description?: ReactNode;
  label: string;
  confirmLabel?: string;
  /** `danger` when the change takes something away (deactivating a person). */
  tone?: 'primary' | 'danger';
  onConfirm: (reason: string) => void;
  onClose: () => void;
  busy?: boolean;
  error?: string | undefined;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const formId = useId();
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={title}
      description={description}
      footer={
        <Button
          type="submit"
          form={formId}
          variant={tone}
          loading={busy}
          disabled={reason.trim().length < 3}
        >
          {confirmLabel ?? t('billing.confirm')}
        </Button>
      }
    >
      <form
        id={formId}
        className="console-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (reason.trim().length >= 3) onConfirm(reason.trim());
        }}
      >
        <TextField
          label={label}
          value={reason}
          maxLength={200}
          error={error}
          data-autofocus
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </form>
    </Dialog>
  );
}
