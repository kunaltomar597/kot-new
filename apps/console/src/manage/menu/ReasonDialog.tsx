import { ConfirmDialog, TextField } from '@rp/ui-web';
import { type ReactNode, useState } from 'react';
import { useT } from '../../app/i18n.js';

/**
 * Archiving is audited with a reason (MENU-010, AUD-001), so it asks for one before going on.
 * Other audited changes use it too, with their own hint, tone and fields above the reason.
 */
export function ReasonDialog({
  title,
  description,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
  hint,
  tone = 'danger',
  children,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  error: string | undefined;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  hint?: string;
  tone?: 'danger' | 'primary';
  children?: ReactNode;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const short = reason.trim().length < 3;
  return (
    <ConfirmDialog
      open
      tone={tone}
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
      {children}
      <TextField
        label={t('menuEditor.reason')}
        hint={hint ?? t('menuEditor.reasonHint')}
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
