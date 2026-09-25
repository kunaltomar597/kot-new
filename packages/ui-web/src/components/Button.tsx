import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from '../internal/cx.js';
import { Spinner } from './Spinner.js';

export const BUTTON_VARIANTS = ['primary', 'secondary', 'ghost', 'danger', 'accent'] as const;
export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];
export type ButtonSize = 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** `md` meets the 48 px touch minimum (NFR-U03); `lg` is for primary actions on touch screens. */
  size?: ButtonSize;
  fullWidth?: boolean;
  /** Shows a spinner, marks the button busy and blocks repeat presses (e.g. double submission). */
  loading?: boolean;
  startIcon?: ReactNode;
  endIcon?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  loading = false,
  startIcon,
  endIcon,
  type = 'button',
  disabled,
  className,
  children,
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      data-variant={variant}
      data-size={size}
      className={cx('rp-button', fullWidth && 'rp-button--full', className)}
    >
      {loading ? <Spinner /> : startIcon}
      <span className="rp-button__label">{children}</span>
      {endIcon}
    </button>
  );
}
