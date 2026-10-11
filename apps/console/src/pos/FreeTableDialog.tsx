import type { TableOverviewEntry } from '@rp/contracts';
import { useToast } from '@rp/ui-web';
import { useState } from 'react';
import { useConsole } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { ReasonDialog } from '../billing/ReasonDialog.js';

/**
 * Frees a table opened by mistake (TBL-004, ADR-0006): only before anything billable is ordered,
 * with a reason for the audit log. The server refuses once an item has been ordered or awaits
 * approval, and the dialog shows its words.
 */
export function FreeTableDialog({
  table,
  sessionId,
  onClose,
  onFreed,
}: {
  table: TableOverviewEntry;
  sessionId: string;
  onClose: () => void;
  onFreed: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const free = async (reason: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await controller.api.closeTableWithoutBill({ params: { sessionId }, body: { reason } });
      toast.show({ title: t('pos.free.freed', { table: table.label }), tone: 'success' });
      onFreed();
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  return (
    <ReasonDialog
      title={t('pos.free.title', { table: table.label })}
      description={t('pos.free.description')}
      label={t('pos.free.reason')}
      confirmLabel={t('pos.free.confirm')}
      tone="danger"
      busy={busy}
      error={error}
      onClose={onClose}
      onConfirm={(reason) => {
        void free(reason);
      }}
    />
  );
}
