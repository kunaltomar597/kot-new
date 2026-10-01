import { businessDateOf, type IsoDate } from '@rp/domain';
import { Button, ErrorState, LoadingState, TextField } from '@rp/ui-web';
import { useId, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useSearchParams } from 'react-router';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { ControlReport } from './ControlReports.js';
import { OperationsReport } from './OperationsReports.js';
import { OrderDrillDownScreen } from './OrderDrillDownScreen.js';
import { PeopleReport } from './PeopleReports.js';
import {
  checkRange,
  presetOf,
  presetRange,
  RANGE_PRESETS,
  type ReportRange,
  rangeFromSearch,
} from './report-view.js';
import { SalesReport } from './SalesReports.js';
import { TaxReport } from './TaxReports.js';

/** The reports in their groups, in the order the navigation lists them. */
export const REPORT_GROUPS = {
  sales: ['sales', 'items', 'sources', 'payments'],
  tax: ['gst', 'register'],
  people: ['staff', 'shifts'],
  controls: ['discounts', 'cancellations', 'reprints'],
  operations: ['kitchen', 'tables', 'suggestions'],
} as const;
export type ReportGroup = keyof typeof REPORT_GROUPS;
export type ReportSlug = (typeof REPORT_GROUPS)[ReportGroup][number];

function RangeFilter({
  range,
  today,
  onChange,
}: {
  range: ReportRange;
  today: IsoDate;
  onChange: (range: ReportRange) => void;
}) {
  const t = useT();
  const formId = useId();
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [problem, setProblem] = useState<string | undefined>();
  const current = presetOf(range, today);
  return (
    <div className="report-filters" role="group" aria-label={t('reportsPage.range.label')}>
      <div className="report-filters__presets">
        {RANGE_PRESETS.map((preset) => (
          <Button
            key={preset}
            variant={current === preset ? 'primary' : 'secondary'}
            aria-pressed={current === preset}
            onClick={() => {
              setProblem(undefined);
              onChange(presetRange(preset, today));
            }}
          >
            {t(`reportsPage.range.${preset}`)}
          </Button>
        ))}
      </div>
      <form
        id={formId}
        className="report-filters__custom"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const wanted = { from, to };
          const issue = checkRange(wanted);
          if (issue !== undefined) {
            setProblem(t(`reportsPage.range.problems.${issue}`));
            return;
          }
          setProblem(undefined);
          onChange(wanted);
        }}
      >
        <TextField
          label={t('reportsPage.range.from')}
          type="date"
          value={from}
          onChange={(event) => {
            setFrom(event.target.value);
          }}
        />
        <TextField
          label={t('reportsPage.range.to')}
          type="date"
          value={to}
          error={problem}
          onChange={(event) => {
            setTo(event.target.value);
          }}
        />
        <Button type="submit" variant="secondary">
          {t('reportsPage.range.show')}
        </Button>
      </form>
    </div>
  );
}

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
