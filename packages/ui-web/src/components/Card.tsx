import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../internal/cx.js';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  /** Heading level for the title, to fit the page outline. */
  headingLevel?: 2 | 3 | 4;
  /** Buttons shown next to the title. */
  actions?: ReactNode;
  footer?: ReactNode;
  /** `raised` adds elevation; `outlined` a border only. */
  variant?: 'outlined' | 'raised';
}

/** A surface that groups related content (a table, an order, a KPI). */
export function Card({
  title,
  headingLevel = 3,
  actions,
  footer,
  variant = 'outlined',
  className,
  children,
  ...rest
}: CardProps) {
  const Heading = `h${String(headingLevel)}` as 'h2' | 'h3' | 'h4';
  return (
    <section {...rest} data-variant={variant} className={cx('rp-card', className)}>
      {title || actions ? (
        <header className="rp-card__header">
          {title ? <Heading className="rp-card__title">{title}</Heading> : null}
          {actions ? <div className="rp-card__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="rp-card__body">{children}</div>
      {footer ? <footer className="rp-card__footer">{footer}</footer> : null}
    </section>
  );
}
