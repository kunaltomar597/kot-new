import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button, ConfirmDialog, Dialog, Sheet } from '../src/index.js';
import { expectNoAxeViolations, renderUi } from './render.js';

function dialogElement() {
  return document.querySelector('dialog')!;
}

describe('[NFR-U01] Dialog', () => {
  it('opens and closes with the open prop and renders content only while open', () => {
    const { rerender } = renderUi(
      <Dialog open={false} onClose={() => undefined} title="Move table">
        Body
      </Dialog>,
    );
    expect(dialogElement().open).toBe(false);
    expect(screen.queryByText('Body')).not.toBeInTheDocument();
    rerender(
      <Dialog open onClose={() => undefined} title="Move table" description="Pick a free table.">
        Body
      </Dialog>,
    );
    expect(dialogElement().open).toBe(true);
    const dialog = screen.getByRole('dialog', { name: 'Move table' });
    expect(dialog).toHaveAccessibleDescription('Pick a free table.');
    expect(screen.getByText('Body')).toBeInTheDocument();
    rerender(
      <Dialog open={false} onClose={() => undefined} title="Move table">
        Body
      </Dialog>,
    );
    expect(dialogElement().open).toBe(false);
  });

  it('asks the parent to close on the close button, Escape and backdrop click', async () => {
    const onClose = vi.fn();
    const { user } = renderUi(
      <Dialog open onClose={onClose} title="Details" footer={<Button>OK</Button>}>
        <p>Inside</p>
      </Dialog>,
    );
    await user.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent(dialogElement(), new Event('cancel', { cancelable: true }));
    fireEvent.click(dialogElement());
    // Clicks inside the panel do not close it.
    await user.click(screen.getByText('Inside'));
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(dialogElement().open).toBe(true);
  });

  it('cannot be dismissed when not dismissible', () => {
    const onClose = vi.fn();
    renderUi(
      <Dialog open onClose={onClose} title="Printing" dismissible={false}>
        Wait
      </Dialog>,
    );
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    const cancel = new Event('cancel', { cancelable: true });
    fireEvent(dialogElement(), cancel);
    fireEvent.click(dialogElement());
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reports a close made by the browser itself', () => {
    const onClose = vi.fn();
    renderUi(<Dialog open onClose={onClose} title="Form" />);
    dialogElement().close();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders as a sheet from the bottom or the side', () => {
    const { rerender } = renderUi(
      <Sheet open onClose={() => undefined} title="Modifiers">
        Pick
      </Sheet>,
    );
    expect(dialogElement()).toHaveAttribute('data-variant', 'sheet');
    expect(dialogElement()).toHaveAttribute('data-side', 'bottom');
    rerender(
      <Sheet open onClose={() => undefined} title="Modifiers" side="end" size="lg">
        Pick
      </Sheet>,
    );
    expect(dialogElement()).toHaveAttribute('data-side', 'end');
  });

  it('has no axe violations when open', async () => {
    const { container } = renderUi(
      <Dialog open onClose={() => undefined} title="Details" description="More">
        <p>Body</p>
      </Dialog>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('[NFR-U04] ConfirmDialog', () => {
  it('asks before a destructive action and focuses Cancel first', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { user } = renderUi(
      <ConfirmDialog
        open
        title="Void this item?"
        description="It will be removed from the bill and listed in the voids report."
        confirmLabel="Void item"
        cancelLabel="Keep item"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    const cancel = screen.getByRole('button', { name: 'Keep item' });
    expect(cancel).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Void item' })).toHaveAttribute(
      'data-variant',
      'danger',
    );
    await user.click(cancel);
    expect(onCancel).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Void item' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('locks while the action runs', () => {
    renderUi(
      <ConfirmDialog
        open
        busy
        tone="primary"
        title="Settle bill?"
        description="Payment will be recorded."
        confirmLabel="Settle"
        cancelLabel="Back"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      >
        <p>Extra</p>
      </ConfirmDialog>,
    );
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Settle' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    expect(screen.getByText('Extra')).toBeInTheDocument();
  });
});
