import {
  type MouseEvent,
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useId,
  useRef,
} from 'react';
import { cx } from '../internal/cx.js';
import { useUiStrings } from '../strings.js';
import { Icon } from './Icon.js';
import { IconButton } from './IconButton.js';

export interface DialogProps {
  open: boolean;
  /** Called when the user asks to close (close button, Escape, backdrop) if `dismissible`. */
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Action buttons, laid out at the end (bottom on phones). */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /**
   * Whether Escape, the backdrop and the close button dismiss it (default). Turn off while an
   * action is running or for a choice that must be made.
   */
  dismissible?: boolean;
  /** `sheet` slides in from an edge; better for long forms and pickers on touch screens. */
  variant?: 'dialog' | 'sheet';
  /** Sheet edge: `bottom` (phones, tablets) or `end` (side panel on wide screens). */
  side?: 'bottom' | 'end';
  className?: string;
}

/**
 * Modal dialog on the native `<dialog>` element: the browser moves focus in, makes the page
 * behind inert, handles Escape and returns focus when it closes. To choose which element gets
 * focus first, give it a `data-autofocus` attribute (not `autoFocus`).
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissible = true,
  variant = 'dialog',
  side = 'bottom',
  className,
}: DialogProps) {
  const strings = useUiStrings().dialog;
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // React's autoFocus runs before showModal (while the dialog is still hidden), so it cannot
      // be used inside a dialog. Mark the element to focus with `data-autofocus` instead.
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const onCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    // Escape: React owns `open`, so keep the dialog up and let the parent decide.
    event.preventDefault();
    if (dismissible) onClose();
  };

  const onNativeClose = () => {
    // Closed by the browser (e.g. a form with method="dialog") while the parent still says open.
    if (open) onClose();
  };

  const onBackdropClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (dismissible && event.target === event.currentTarget) onClose();
  };

  return (
    // The dialog element handles keyboard (Escape) natively; the click handler only adds
    // backdrop dismissal for pointer users.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- see above
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      data-size={size}
      data-variant={variant}
      data-side={variant === 'sheet' ? side : undefined}
      className={cx('rp-dialog', className)}
      onCancel={onCancel}
      onClose={onNativeClose}
      onClick={onBackdropClick}
    >
      {open ? (
        <div className="rp-dialog__panel">
          <header className="rp-dialog__header">
            <h2 id={titleId} className="rp-dialog__title">
              {title}
            </h2>
            {dismissible ? (
              <IconButton
                label={strings.close}
                icon={<Icon name="close" />}
                onClick={onClose}
                className="rp-dialog__close"
              />
            ) : null}
          </header>
          {description ? (
            <p id={descriptionId} className="rp-dialog__description">
              {description}
            </p>
          ) : null}
          {children ? <div className="rp-dialog__body">{children}</div> : null}
          {footer ? <footer className="rp-dialog__footer">{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>
  );
}

export type SheetProps = Omit<DialogProps, 'variant'>;

/** A dialog that slides in from the bottom or the side. */
export function Sheet(props: SheetProps) {
  return <Dialog {...props} variant="sheet" />;
}
