import type {
  KitchenReportResponse,
  RecommendationReportResponse,
  TableReportResponse,
} from '@rp/contracts';
import { Table } from '@rp/ui-web';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { axisRupees, duration, percent, type ReportRange, rupees } from './report-view.js';
import {
  BarChartFigure,
  ExportButtons,
  moneyColumn,
  numberColumn,
  ReportBody,
  ReportSection,
  StatTiles,
  textColumn,
} from './ReportParts.js';
import { FeedbackReport } from './FeedbackReport.js';
import { useReport } from './use-report.js';

type Slug = 'kitchen' | 'tables' | 'suggestions' | 'feedback';
type Translate = ReturnType<typeof useT>;
type StationRow = KitchenReportResponse['stations'][number];
type DishRow = KitchenReportResponse['items'][number];
type TableRow = TableReportResponse['tables'][number];
type LayerRow = RecommendationReportResponse['layers'][number];
type SuggestedRow = RecommendationReportResponse['items'][number];

const seconds = (value: number | null, t: Translate) => (value === null ? '–' : duration(value, t));

/** RPT-010: how long dishes take to cook and to be collected, by station and dish. */
function Kitchen({ range }: { range: ReportRange }) {
  const t = useT();
  const { api } = useConsole();
  const { data, reload } = useReport((wanted) => api.getKitchenReport({ query: wanted }), range);
  return (
    <ReportBody data={data} reload={reload}>
      {(report) => (
        <ReportSection
          id="report-kitchen"
          title={t('reportsPage.report.kitchen')}
          action={<ExportButtons report="KITCHEN" range={range} />}
        >
          <StatTiles
            stats={[
              {
                label: t('reportsPage.kitchen.prep'),
                value: seconds(report.totals.averagePrepSeconds, t),
              },
              {
                label: t('reportsPage.kitchen.pickup'),
                value: seconds(report.totals.averagePickupSeconds, t),
              },
              { label: t('reportsPage.kitchen.dishes'), value: String(report.totals.quantity) },
              {
                label: t('reportsPage.kitchen.notify'),
                value: String(report.totals.notifyManager),
              },
            ]}
          />
          {report.stations.some((station) => station.averagePrepSeconds !== null) ? (
            <BarChartFigure
              title={t('reportsPage.kitchen.chart')}
              horizontal
              data={report.stations.map((station) => ({
                key: station.stationId,
                label: station.name,
                value: station.averagePrepSeconds ?? 0,
              }))}
              format={(value) => duration(value, t)}
              axisFormat={(value) => duration(value, t)}
            />
          ) : null}
          <Table<StationRow>
            caption={t('reportsPage.kitchen.stations')}
            columns={[
              textColumn('station', t('reportsPage.columns.station'), (row) => row.name),
              numberColumn('dishes', t('reportsPage.kitchen.dishes'), (row) => row.quantity),
              textColumn('prep', t('reportsPage.kitchen.prep'), (row) =>
                seconds(row.averagePrepSeconds, t),
              ),
              textColumn('pickup', t('reportsPage.kitchen.pickup'), (row) =>
                seconds(row.averagePickupSeconds, t),
              ),
              numberColumn('notify', t('reportsPage.kitchen.notify'), (row) => row.notifyManager),
            ]}
            rows={report.stations}
            rowKey={(row) => row.stationId}
            empty={t('reportsPage.none')}
          />
          <Table<DishRow>
            caption={t('reportsPage.kitchen.dishesTable')}
            columns={[
              textColumn('dish', t('reportsPage.columns.dish'), (row) => row.name),
              textColumn('station', t('reportsPage.columns.station'), (row) => row.station),
              numberColumn('quantity', t('reportsPage.columns.quantity'), (row) => row.quantity),
              textColumn('prep', t('reportsPage.kitchen.prep'), (row) =>
                seconds(row.averagePrepSeconds, t),
              ),
              textColumn('pickup', t('reportsPage.kitchen.pickup'), (row) =>
                seconds(row.averagePickupSeconds, t),
              ),
            ]}
            rows={report.items}
            rowKey={(row) => row.itemId}
            empty={t('reportsPage.none')}
          />
        </ReportSection>
      )}
    </ReportBody>
  );
}

/** RPT-011: covers, turnover, seated time and spend per cover. */
function Tables({ range }: { range: ReportRange }) {
  const t = useT();
  const { api } = useConsole();
  const { data, reload } = useReport((wanted) => api.getTableReport({ query: wanted }), range);
  const perCover = (value: number | null) => (value === null ? '–' : rupees(value));
  return (
    <ReportBody data={data} reload={reload}>
      {(report) => (
        <ReportSection
          id="report-tables"
          title={t('reportsPage.report.tables')}
          action={<ExportButtons report="TABLES" range={range} />}
        >
          <StatTiles
            stats={[
              { label: t('reportsPage.tables.covers'), value: String(report.totals.covers) },
              { label: t('reportsPage.tables.sessions'), value: String(report.totals.sessions) },
              {
                label: t('reportsPage.tables.turnover'),
                value: t('reportsPage.tables.turnoverValue', {
                  turns: (report.totals.turnoverBp / 10_000).toFixed(2),
                }),
              },
              {
                label: t('reportsPage.tables.seated'),
                value: seconds(report.totals.averageSeatedSeconds, t),
              },
              {
                label: t('reportsPage.tables.spendPerCover'),
                value: perCover(report.totals.spendPerCover),
              },
            ]}
          />
          <Table<TableRow>
            caption={t('reportsPage.tables.table')}
            columns={[
              textColumn('table', t('reportsPage.columns.table'), (row) => row.label),
              numberColumn('sessions', t('reportsPage.tables.sessions'), (row) => row.sessions),
              numberColumn('covers', t('reportsPage.tables.covers'), (row) => row.covers),
              textColumn('seated', t('reportsPage.tables.seated'), (row) =>
                seconds(row.averageSeatedSeconds, t),
              ),
              moneyColumn('spend', t('reportsPage.tables.spend'), (row) => row.spend),
              textColumn('perCover', t('reportsPage.tables.spendPerCover'), (row) =>
                perCover(row.spendPerCover),
              ),
            ]}
            rows={report.tables}
            rowKey={(row) => row.tableId}
            empty={t('reportsPage.none')}
          />
        </ReportSection>
      )}
    </ReportBody>
  );
}

/** RPT-012: suggestions shown, opened, added and ordered, with revenue, per layer and dish. */
function Suggestions({ range }: { range: ReportRange }) {
  const t = useT();
  const { api } = useConsole();
  const { data, reload } = useReport(
    (wanted) => api.getRecommendationReport({ query: wanted }),
    range,
  );
  const rate = (bp: number | null) => (bp === null ? '–' : percent(bp));
  return (
    <ReportBody data={data} reload={reload}>
      {(report) => (
        <ReportSection
          id="report-suggestions"
          title={t('reportsPage.report.suggestions')}
          action={<ExportButtons report="RECOMMENDATIONS" range={range} />}
        >
          <StatTiles
            stats={[
              { label: t('reportsPage.suggestions.revenue'), value: rupees(report.totals.revenue) },
              {
                label: t('reportsPage.suggestions.attach'),
                value: rate(report.totals.attachRateBp),
              },
              {
                label: t('reportsPage.suggestions.orders'),
                value: t('reportsPage.suggestions.ordersValue', {
                  withSuggestion: report.totals.ordersWithSuggestion,
                  orders: report.totals.orders,
                }),
              },
              {
                label: t('reportsPage.suggestions.shown'),
                value: String(report.totals.impressions),
              },
            ]}
          />
          <BarChartFigure
            title={t('reportsPage.suggestions.chart')}
            data={report.layers.map((layer) => ({
              key: layer.layer,
              label: t(`reportsPage.layer.${layer.layer}`),
              value: layer.revenue,
            }))}
            format={rupees}
            axisFormat={(value) => axisRupees(value, t)}
          />
          <Table<LayerRow>
            caption={t('reportsPage.suggestions.layers')}
            columns={[
              textColumn('layer', t('reportsPage.columns.layer'), (row) =>
                t(`reportsPage.layer.${row.layer}`),
              ),
              numberColumn('shown', t('reportsPage.suggestions.shown'), (row) => row.impressions),
              numberColumn('opened', t('reportsPage.suggestions.opened'), (row) => row.taps),
              numberColumn('added', t('reportsPage.suggestions.added'), (row) => row.addedToCart),
              numberColumn('ordered', t('reportsPage.suggestions.ordered'), (row) => row.ordered),
              textColumn('attach', t('reportsPage.suggestions.attach'), (row) =>
                rate(row.attachRateBp),
              ),
              moneyColumn('revenue', t('reportsPage.suggestions.revenue'), (row) => row.revenue),
            ]}
            rows={report.layers}
            rowKey={(row) => row.layer}
            empty={t('reportsPage.none')}
          />
          <Table<SuggestedRow>
            caption={t('reportsPage.suggestions.dishes')}
            columns={[
              textColumn('dish', t('reportsPage.columns.dish'), (row) => row.name),
              numberColumn('shown', t('reportsPage.suggestions.shown'), (row) => row.impressions),
              numberColumn('ordered', t('reportsPage.suggestions.ordered'), (row) => row.ordered),
              textColumn('attach', t('reportsPage.suggestions.attach'), (row) =>
                rate(row.attachRateBp),
              ),
              moneyColumn('revenue', t('reportsPage.suggestions.revenue'), (row) => row.revenue),
            ]}
            rows={report.items}
            rowKey={(row) => row.itemId}
            empty={t('reportsPage.none')}
          />
        </ReportSection>
      )}
    </ReportBody>
  );
}

export function OperationsReport({ slug, range }: { slug: Slug; range: ReportRange }) {
  switch (slug) {
    case 'kitchen':
      return <Kitchen range={range} />;
    case 'tables':
      return <Tables range={range} />;
    case 'suggestions':
      return <Suggestions range={range} />;
    case 'feedback':
      return <FeedbackReport range={range} />;
  }
}
