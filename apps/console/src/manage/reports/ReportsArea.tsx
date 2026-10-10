import { businessDateOf } from '@rp/domain';
import { ErrorState, LoadingState } from '@rp/ui-web';
import { Navigate, NavLink, Route, Routes, useSearchParams } from 'react-router';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { ControlReport } from './ControlReports.js';
import { OperationsReport } from './OperationsReports.js';
import { OrderDrillDownScreen } from './OrderDrillDownScreen.js';
import { PeopleReport } from './PeopleReports.js';
import { RangeFilter } from './RangeFilter.js';
import { rangeFromSearch } from './report-view.js';
import { SalesReport } from './SalesReports.js';
import { TaxReport } from './TaxReports.js';

/** The reports in their groups, in the order the navigation lists them. */
export const REPORT_GROUPS = {
  sales: ['sales', 'items', 'sources', 'payments'],
  tax: ['gst', 'register'],
  people: ['staff', 'shifts'],
  controls: ['discounts', 'cancellations', 'reprints', 'suspicious'],
  operations: ['approvals', 'kitchen', 'tables', 'suggestions', 'feedback'],
} as const;
export type ReportGroup = keyof typeof REPORT_GROUPS;
export type ReportSlug = (typeof REPORT_GROUPS)[ReportGroup][number];

/**
 * The Reports area (P4-05d, RPT-016): one range for every report in a row above them, the
 * reports in their groups, each as headline figures, a chart where one helps and the table with
 * every figure, and drill-down from any order to everything that happened to it (RPT-015). The
 * range lives in the address, so a report can be bookmarked or sent.
 */
export function ReportsArea() {
  const t = useT();
  const controller = useConsole();
  const [search, setSearch] = useSearchParams();
  const { data: restaurant, reload } = useLive(
    () => controller.api.getRestaurant(),
    (type) => type === 'RestaurantChanged',
  );
  if (restaurant.status === 'loading') return <LoadingState title={t('states.loading')} />;
  if (restaurant.status === 'error') {
    return (
      <ErrorState
        title={t('reportsPage.loadFailed')}
        description={messageOf(restaurant.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  }
  const today = businessDateOf(new Date(), {
    cutoff: restaurant.value.businessDayCutoff,
    timeZone: restaurant.value.timeZone,
  });
  const range = rangeFromSearch(search, today);
  const query = `?from=${range.from}&to=${range.to}`;
  // Absolute: under the `reports/*` route a relative link would resolve below the open report.
  const pathOf = (slug: ReportSlug) => `/manage/reports/${slug}${query}`;
  return (
    <section className="dashboard-section" aria-labelledby="dashboard-reports">
      <h2 id="dashboard-reports" className="dashboard-section__heading">
        {t('reportsPage.title')}
      </h2>
      <RangeFilter
        // A new range (a preset, or the address) starts the form again from it.
        key={`${range.from}|${range.to}`}
        range={range}
        today={today}
        onChange={(next) => {
          setSearch({ from: next.from, to: next.to });
        }}
      />
      <nav className="report-nav" aria-label={t('reportsPage.navigation')}>
        {(Object.keys(REPORT_GROUPS) as ReportGroup[]).map((group) => (
          <div key={group} className="report-nav__group">
            <span className="report-nav__heading">{t(`reportsPage.group.${group}`)}</span>
            {REPORT_GROUPS[group].map((slug) => (
              <NavLink key={slug} to={pathOf(slug)} className="staff-pages__link">
                {t(`reportsPage.report.${slug}`)}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <Routes>
        <Route index element={<Navigate to={pathOf('sales')} replace />} />
        {REPORT_GROUPS.sales.map((slug) => (
          <Route key={slug} path={slug} element={<SalesReport slug={slug} range={range} />} />
        ))}
        {REPORT_GROUPS.tax.map((slug) => (
          <Route key={slug} path={slug} element={<TaxReport slug={slug} range={range} />} />
        ))}
        {REPORT_GROUPS.people.map((slug) => (
          <Route key={slug} path={slug} element={<PeopleReport slug={slug} range={range} />} />
        ))}
        {REPORT_GROUPS.controls.map((slug) => (
          <Route key={slug} path={slug} element={<ControlReport slug={slug} range={range} />} />
        ))}
        {REPORT_GROUPS.operations.map((slug) => (
          <Route key={slug} path={slug} element={<OperationsReport slug={slug} range={range} />} />
        ))}
        <Route path="orders/:orderId" element={<OrderDrillDownScreen />} />
        <Route path="*" element={<Navigate to={pathOf('sales')} replace />} />
      </Routes>
    </section>
  );
}
