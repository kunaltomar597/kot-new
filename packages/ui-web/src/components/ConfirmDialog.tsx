import type { ReactNode } from 'react';
import { Button } from './Button.js';
import { Dialog } from './Dialog.js';

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  /** What will happen, in plain language (e.g. "The bill will be voided and reprinted"). */
  description: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** `danger` for destructive actions (void, cancel, delete); `primary` otherwise. */
  tone?: 'danger' | 'primary';
  /** The confirmed action is running: the buttons are locked and the dialog cannot be dismissed. */
  busy?: boolean;
  /** Extra content such as a reason field. */
  children?: ReactNode;
}

/**
 * Asks before a destructive or irreversible action (NFR-U04). Cancel is focused first, so an
 * accidental Enter never confirms.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  tone = 'danger',
  busy = false,
  children,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      size="sm"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy} data-autofocus>
            {cancelLabel}
          </Button>
          <Button variant={tone} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
