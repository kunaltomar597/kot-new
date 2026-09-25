import type { Tone } from '@rp/design-tokens';
import type { OrderItemState } from '@rp/domain';
import { cx } from '../internal/cx.js';
import { Icon, type IconName } from './Icon.js';

/**
 * How each order item state looks everywhere (POS, KDS, waiter app, tablet): a tone and an icon,
 * always next to the state's name, so colour is never the only signal (NFR-U05).
 */
export const ORDER_ITEM_STATE_STYLES: Readonly<
  Record<OrderItemState, { readonly tone: Tone; readonly icon: IconName }>
> = {
  PENDING_APPROVAL: { tone: 'warning', icon: 'clock' },
  SENT: { tone: 'info', icon: 'send' },
  PREPARING: { tone: 'info', icon: 'flame' },
  READY: { tone: 'success', icon: 'check' },
  PICKED_UP: { tone: 'success', icon: 'handPlatter' },
  SERVED: { tone: 'neutral', icon: 'checkDouble' },
  REJECTED: { tone: 'danger', icon: 'xCircle' },
  CANCELLED: { tone: 'danger', icon: 'xCircle' },
  VOIDED: { tone: 'danger', icon: 'ban' },
};

export interface StatusChipProps {
  state: OrderItemState;
  /** The state's name from the i18n catalogue, e.g. "Ready". */
  label: string;
  size?: 'md' | 'lg';
  className?: string;
}

/** The order item status chip reused on every surface (NFR-M01). */
export function StatusChip({ state, label, size = 'md', className }: StatusChipProps) {
  const style = ORDER_ITEM_STATE_STYLES[state];
  return (
    <span
      data-tone={style.tone}
      data-state={state}
      data-size={size}
      className={cx('rp-status-chip', className)}
    >
      <Icon name={style.icon} />
      {label}
    </span>
  );
}
