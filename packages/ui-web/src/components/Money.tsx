import { formatRupees, type Paise } from '@rp/domain';
import type { HTMLAttributes } from 'react';
import { cx } from '../internal/cx.js';

export interface MoneyProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  /** Integer paise (BRD §9.4). Never rupees, never a float: a non-integer throws. */
  paise: Paise;
  /** Show the ₹ symbol (default). Hide it in dense tables whose header names the currency. */
  symbol?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Colour negative amounts (refunds, discounts) as danger; the minus sign is always shown. */
  signTone?: boolean;
  strong?: boolean;
}

/**
 * Displays an amount of money, formatted by `@rp/domain` (Indian grouping, 2 decimals) with
 * tabular digits so columns line up. The raw paise value is kept in `<data value>`.
 */
export function Money({
  paise,
  symbol = true,
  size = 'md',
  signTone = false,
  strong = false,
  className,
  ...rest
}: MoneyProps) {
  return (
    <data
      {...rest}
      value={String(paise)}
      data-size={size}
      data-negative={(signTone && paise < 0) || undefined}
      data-strong={strong || undefined}
      className={cx('rp-money', className)}
    >
      {formatRupees(paise, { symbol })}
    </data>
  );
}
