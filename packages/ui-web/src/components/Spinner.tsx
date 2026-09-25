import { cx } from '../internal/cx.js';

/** Decorative progress indicator; pair it with text or `aria-busy` (it is hidden from AT). */
export function Spinner({ className }: { className?: string }) {
  return <span className={cx('rp-spinner', className)} aria-hidden="true" />;
}
