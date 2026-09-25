import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from '../internal/cx.js';
import type { ButtonSize, ButtonVariant } from './Button.js';

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'aria-label'
> {
  /** Accessible name; required because the button has no visible text. Also used as tooltip. */
  label: string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  ref?: Ref<HTMLButtonElement>;
}

/** Square icon-only button, at least 48 × 48 px (NFR-U03). */
export function IconButton({
  label,
  icon,
  variant = 'ghost',
  size = 'md',
  type = 'button',
  title,
  className,
  ref,
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      data-variant={variant}
      data-size={size}
      className={cx('rp-button', 'rp-icon-button', className)}
    >
      {icon}
    </button>
  );
}
