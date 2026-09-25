import type { ReactNode } from 'react';
import { cx } from '../internal/cx.js';
import { Icon } from './Icon.js';
import { Spinner } from './Spinner.js';

export const CONNECTION_STATUSES = ['online', 'reconnecting', 'offline'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export interface ConnectionBannerProps {
  status: ConnectionStatus;
  /** What is happening and what still works, e.g. "Can't reach the server. Retrying…". */
  message: ReactNode;
  /** Optional action such as a "Retry now" button. */
  action?: ReactNode;
  className?: string;
}

/**
 * Tells staff when the device has lost the local server. Hidden while online; `reconnecting` is a
 * polite status, `offline` an alert.
 */
export function ConnectionBanner({ status, message, action, className }: ConnectionBannerProps) {
  if (status === 'online') return null;
  const offline = status === 'offline';
  return (
    <div
      role={offline ? 'alert' : 'status'}
      data-status={status}
      data-tone={offline ? 'danger' : 'warning'}
      className={cx('rp-connection-banner', className)}
    >
      {offline ? <Icon name="offline" /> : <Spinner />}
      <span className="rp-connection-banner__message">{message}</span>
      {action}
    </div>
  );
}
