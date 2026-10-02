import type { ReactNode } from 'react';

/** A page of the app: its heading, an optional line on what it is for, and its actions. */
export function Page({
  title,
  intro,
  actions,
  back,
  children,
}: {
  title: ReactNode;
  intro?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="cp-page" aria-labelledby="cp-page-title">
      {back}
      <div className="cp-page__header">
        <div>
          <h1 id="cp-page-title" className="cp-page__title">
            {title}
          </h1>
          {intro === undefined ? null : <p className="cp-page__intro">{intro}</p>}
        </div>
        {actions === undefined ? null : <div className="cp-page__actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
