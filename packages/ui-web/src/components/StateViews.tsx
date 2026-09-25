import type { ReactNode } from 'react';
import { cx } from '../internal/cx.js';
import { Button } from './Button.js';
import { Icon, type IconName } from './Icon.js';
import { Spinner } from './Spinner.js';

interface StateViewProps {
  title: ReactNode;
  /** What this means and what to do next, in plain language (NFR-U04). */
  description?: ReactNode;
  /** Buttons or links, e.g. "Add a menu item". */
  action?: ReactNode;
  className?: string;
}

function StateView({
  kind,
  icon,
  role,
  title,
  description,
  action,
  className,
}: StateViewProps & { kind: string; icon: ReactNode; role?: 'status' | 'alert' }) {
  return (
    <div role={role} data-kind={kind} className={cx('rp-state', className)}>
      <div className="rp-state__icon">{icon}</div>
      <p className="rp-state__title">{title}</p>
      {description ? <p className="rp-state__description">{description}</p> : null}
      {action ? <div className="rp-state__action">{action}</div> : null}
    </div>
  );
}

export interface EmptyStateProps extends StateViewProps {
  icon?: IconName;
}

/** Shown when a list or screen has nothing in it yet (NFR-U04). */
export function EmptyState({ icon = 'inbox', ...props }: EmptyStateProps) {
  return <StateView kind="empty" icon={<Icon name={icon} size={40} />} {...props} />;
}

/** Shown while data loads; announced politely to screen readers. */
export function LoadingState(props: StateViewProps) {
  return (
    <StateView
      kind="loading"
      role="status"
      icon={<Spinner className="rp-spinner--large" />}
      {...props}
    />
  );
}

export interface ErrorStateProps extends StateViewProps {
  /** Adds a retry button with this label when both are given. */
  onRetry?: () => void;
  retryLabel?: string;
}

/** Shown when something failed; says what happened and what to do next (NFR-U04). */
export function ErrorState({ onRetry, retryLabel, action, ...props }: ErrorStateProps) {
  const retry =
    onRetry && retryLabel ? (
      <Button variant="secondary" startIcon={<Icon name="sync" />} onClick={onRetry}>
        {retryLabel}
      </Button>
    ) : null;
  return (
    <StateView
      kind="error"
      role="alert"
      icon={<Icon name="error" size={40} />}
      action={
        retry || action ? (
          <>
            {retry}
            {action}
          </>
        ) : undefined
      }
      {...props}
    />
  );
}
