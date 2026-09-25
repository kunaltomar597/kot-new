import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Button, ConfirmDialog, Dialog, Sheet, TextField, useToast } from '../src/index.js';

const meta: Meta<typeof Dialog> = {
  title: 'Overlays/Dialogs and toasts',
  component: Dialog,
};
export default meta;
type Story = StoryObj<typeof Dialog>;

export const DialogAndSheets: Story = {
  render: function Render() {
    const [open, setOpen] = useState<'dialog' | 'bottom' | 'end' | null>(null);
    const close = () => {
      setOpen(null);
    };
    return (
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Button
          onClick={() => {
            setOpen('dialog');
          }}
        >
          Open dialog
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setOpen('bottom');
          }}
        >
          Open bottom sheet
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setOpen('end');
          }}
        >
          Open side sheet
        </Button>
        <Dialog
          open={open === 'dialog'}
          onClose={close}
          title="Move table"
          description="Items and the running bill move with the guests."
          footer={
            <>
              <Button variant="secondary" onClick={close}>
                Cancel
              </Button>
              <Button onClick={close}>Move</Button>
            </>
          }
        >
          <TextField label="New table number" inputMode="numeric" />
        </Dialog>
        <Sheet
          open={open === 'bottom' || open === 'end'}
          side={open === 'end' ? 'end' : 'bottom'}
          onClose={close}
          title="Choose spice level"
          footer={<Button onClick={close}>Add to order</Button>}
        >
          <p>Modifier choices go here (P1-08).</p>
        </Sheet>
      </div>
    );
  },
};

export const Confirmation: Story = {
  render: function Render() {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    return (
      <>
        <Button
          variant="danger"
          onClick={() => {
            setOpen(true);
          }}
        >
          Void item
        </Button>
        <ConfirmDialog
          open={open}
          busy={busy}
          title="Void Paneer tikka?"
          description="It will be removed from the bill and listed in the voids report. A manager PIN is needed next."
          confirmLabel="Void item"
          cancelLabel="Keep item"
          onCancel={() => {
            setOpen(false);
          }}
          onConfirm={() => {
            setBusy(true);
            setTimeout(() => {
              setBusy(false);
              setOpen(false);
            }, 800);
          }}
        >
          <TextField label="Reason" required />
        </ConfirmDialog>
      </>
    );
  },
};

export const Toasts: Story = {
  render: function Render() {
    const toast = useToast();
    return (
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Button
          onClick={() =>
            toast.show({
              title: 'Order sent',
              description: 'KOT 42 printed at Tandoor',
              tone: 'success',
            })
          }
        >
          Success
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            toast.show({
              title: 'Item removed',
              action: { label: 'Undo', onAction: () => undefined },
            })
          }
        >
          With action
        </Button>
        <Button
          variant="danger"
          onClick={() =>
            toast.show({
              title: 'Printer offline',
              description: 'Check the Tandoor printer cable and power, then reprint.',
              tone: 'danger',
            })
          }
        >
          Error (stays)
        </Button>
      </div>
    );
  },
};
