import { ConfirmDialog, TextField } from '@rp/ui-web';
import { useState } from 'react';
import { useT } from '../../app/i18n.js';

/** Archiving is audited with a reason (MENU-010, AUD-001), so it asks for one before going on. */
export function ReasonDialog({
  title,
  description,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  error: string | undefined;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const short = reason.trim().length < 3;
  return (
    <ConfirmDialog
      open
      tone="danger"
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      cancelLabel={t('menuEditor.cancel')}
      busy={busy}
      onConfirm={() => {
        setSubmitted(true);
        if (!short) onConfirm(reason.trim());
      }}
      onCancel={onCancel}
    >
      <TextField
        label={t('menuEditor.reason')}
        hint={t('menuEditor.reasonHint')}
        value={reason}
        maxLength={200}
        autoComplete="off"
        required
        data-autofocus
        error={submitted && short ? t('menuEditor.reasonRequired') : undefined}
        onChange={(event) => {
          setReason(event.target.value);
        }}
      />
      {error === undefined ? null : (
        <p role="alert" className="console-notice console-notice--danger">
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
}
