import type { OfferedUpdate, SystemUpdates } from '@rp/contracts';
import { TextField, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { FormDialog } from '../settings/FormDialog.js';

/**
 * "Install now" (UPD-004): approves the offered release for the update agent. A security update
 * while tables are open needs the manager's reason; the server checks the tables again and its
 * refusal shows in the dialog.
 */
export function InstallNowDialog({
  offered,
  needsReason,
  onClose,
  onApproved,
}: {
  offered: OfferedUpdate;
  needsReason: boolean;
  onClose: () => void;
  onApproved: (updates: SystemUpdates) => void;
}) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const reasonShort = needsReason && reason.trim().length < 3;

  const approve = async () => {
    setSubmitted(true);
    if (reasonShort) return;
    setBusy(true);
    setError(undefined);
    try {
      const updates = await controller.api.approveUpdateInstall({
        body: { version: offered.version, ...(needsReason && { reason: reason.trim() }) },
      });
      toast.show({
        title: t('system.install.approved', { version: offered.version }),
        tone: 'success',
      });
      onApproved(updates);
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  return (
    <FormDialog
      title={t('system.install.title', { version: offered.version })}
      description={needsReason ? t('system.install.security') : t('system.install.description')}
      confirmLabel={t('system.install.confirm')}
      busy={busy}
      error={error}
      onClose={onClose}
      onConfirm={() => {
        void approve();
      }}
    >
      {needsReason ? (
        <TextField
          label={t('system.install.reason')}
          value={reason}
          maxLength={200}
          autoComplete="off"
          data-autofocus
          error={submitted && reasonShort ? t('system.install.reasonShort') : undefined}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      ) : null}
    </FormDialog>
  );
}
