import type {
  ItemSalesResponse,
  PaymentModesResponse,
  SalesSummaryResponse,
  SourceSalesResponse,
} from '@rp/contracts';
import { Table, type TableColumn } from '@rp/ui-web';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
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
import { axisRupees, daysIn, type ReportRange, rupees, shortDate } from './report-view.js';
import { useReport } from './use-report.js';

type Slug = 'sales' | 'items' | 'sources' | 'payments';
type Translate = ReturnType<typeof useT>;
type Totals = SalesSummaryResponse['totals'];
type DayRow = SalesSummaryResponse['byDay'][number];
type HourRow = SalesSummaryResponse['byHour'][number];

function totalsColumns<Row extends Totals>(t: Translate): TableColumn<Row>[] {
  return [
    numberColumn('invoices', t('reportsPage.sales.invoices'), (row) => row.invoices),
    moneyColumn('gross', t('reportsPage.sales.gross'), (row) => row.grossSales),
    moneyColumn('discounts', t('reportsPage.sales.discounts'), (row) => row.discounts),
    moneyColumn('service', t('reportsPage.sales.serviceCharge'), (row) => row.serviceCharge),
    moneyColumn('tax', t('reportsPage.sales.tax'), (row) => row.tax),
    moneyColumn('net', t('reportsPage.sales.net'), (row) => row.netSales),
  ];
}

const hourText = (hour: number, t: Translate) =>
  t('reportsPage.sales.hour', { hour: String(hour).padStart(2, '0') });

/** RPT-001: sales by day (or by hour for one day), with every total. */
function SalesSummary({ range }: { range: ReportRange }) {
  const t = useT();
  const { api } = useConsole();
  const { data, reload } = useReport((wanted) => api.getSalesSummary({ query: wanted }), range);
  return (
    <ReportBody data={data} reload={reload}>
      {(sales) => {
        const byDay = daysIn(range) > 1;
        const { totals } = sales;
        return (
          <ReportSection
            id="report-sales"
            title={t('reportsPage.report.sales')}
            action={<ExportButtons report="SALES" range={range} />}
          >
            <StatTiles
              stats={[
                { label: t('reportsPage.sales.net'), value: rupees(totals.netSales) },
                { label: t('reportsPage.sales.invoices'), value: String(totals.invoices) },
                {
                  label: t('reportsPage.sales.average'),
                  value:
                    totals.invoices === 0
                      ? '–'
                      : rupees(Math.round(totals.netSales / totals.invoices)),
                },
                { label: t('reportsPage.sales.discounts'), value: rupees(totals.discounts) },
                { label: t('reportsPage.sales.tax'), value: rupees(totals.tax) },
              ]}
            />
            <BarChartFigure
              title={byDay ? t('reportsPage.sales.chartByDay') : t('reportsPage.sales.chartByHour')}
              data={
                byDay
                  ? sales.byDay.map((day) => ({
                      key: day.businessDate,
                      label: shortDate(day.businessDate, t),
                      value: day.netSales,
                    }))
                  : sales.byHour.map((hour) => ({
                      key: String(hour.hour),
                      label: hourText(hour.hour, t),
                      value: hour.netSales,
                    }))
              }
              format={rupees}
              axisFormat={(value) => axisRupees(value, t)}
            />
            <Table<DayRow>
              caption={t('reportsPage.sales.byDay')}
              columns={[
                textColumn('date', t('reportsPage.columns.date'), (row) =>
                  shortDate(row.businessDate, t),
                ),
                ...totalsColumns<DayRow>(t),
              ]}
              rows={sales.byDay}
              rowKey={(row) => row.businessDate}
              empty={t('reportsPage.none')}
            />
            <Table<HourRow>
              caption={t('reportsPage.sales.byHour')}
              columns={[
                textColumn('hour', t('reportsPage.columns.hour'), (row) => hourText(row.hour, t)),
                ...totalsColumns<HourRow>(t),
              ]}
              rows={sales.byHour}
              rowKey={(row) => String(row.hour)}
              empty={t('reportsPage.none')}
            />
          </ReportSection>
        );
      }}
    </ReportBody>
  );
}

type ItemRow = ItemSalesResponse['items'][number];
type CategoryRow = ItemSalesResponse['categories'][number];

function itemFigures<Row extends CategoryRow>(t: Translate): TableColumn<Row>[] {
  return [
    numberColumn('quantity', t('reportsPage.columns.quantity'), (row) => row.quantity),
    moneyColumn('gross', t('reportsPage.sales.gross'), (row) => row.gross),
    moneyColumn('discounts', t('reportsPage.sales.discounts'), (row) => row.discounts),
    moneyColumn('net', t('reportsPage.items.net'), (row) => row.net),
    moneyColumn('tax', t('reportsPage.sales.tax'), (row) => row.tax),
  ];
}

/** RPT-002: what sold, by dish and by category, with the ten best sellers charted. */
function ItemSales({ range }: { range: ReportRange }) {
  const t = useT();
  const { api } = useConsole();
  const { data, reload } = useReport((wanted) => api.getItemSales({ query: wanted }), range);
  return (
    <ReportBody data={data} reload={reload}>
      {(items) => (
        <ReportSection
          id="report-items"
          title={t('reportsPage.report.items')}
          action={<ExportButtons report="ITEMS" range={range} />}
        >
          {items.items.length === 0 ? null : (
            <BarChartFigure
              title={t('reportsPage.items.chart')}
              horizontal
              data={items.items.slice(0, 10).map((item) => ({
                key: item.itemId,
                label: item.name,
                value: item.net,
              }))}
              format={rupees}
              axisFormat={(value) => axisRupees(value, t)}
            />
          )}
          <Table<ItemRow>
            caption={t('reportsPage.items.dishes')}
            columns={[
              textColumn('name', t('reportsPage.columns.dish'), (row) => row.name),
              textColumn('category', t('reportsPage.columns.category'), (row) => row.category),
              ...itemFigures<ItemRow>(t),
            ]}
            rows={items.items}
            rowKey={(row) => row.itemId}
            empty={t('reportsPage.none')}
          />
          <Table<CategoryRow>
            caption={t('reportsPage.items.categories')}
            columns={[
              textColumn('category', t('reportsPage.columns.category'), (row) => row.category),
              ...itemFigures<CategoryRow>(t),
            ]}
            rows={items.categories}
            rowKey={(row) => row.categoryId}
            empty={t('reportsPage.none')}
          />
        </ReportSection>
      )}
    </ReportBody>
  );
}

type SourceRow = SourceSalesResponse['rows'][number];
const SOURCES = ['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR'] as const;
const ORDER_TYPES = ['DINE_IN', 'TAKEAWAY'] as const;

/** RPT-004: billed sales by where orders came from and by dine-in or takeaway. */
function SourceSales({ range }: { range: ReportRange }) {
  const t = useT();
  const { api } = useConsole();
  const { data, reload } = useReport((wanted) => api.getSourceSales({ query: wanted }), range);
  return (
    <ReportBody data={data} reload={reload}>
      {(sources) => {
        const netOf = (match: (row: SourceRow) => boolean) =>
          sources.rows.filter(match).reduce((total, row) => total + row.net, 0);
        return (
          <ReportSection
            id="report-sources"
            title={t('reportsPage.report.sources')}
            action={<ExportButtons report="SOURCES" range={range} />}
          >
            <StatTiles
              stats={[
                { label: t('reportsPage.items.net'), value: rupees(sources.totals.net) },
                { label: t('reportsPage.sources.orders'), value: String(sources.totals.orders) },
                ...ORDER_TYPES.map((type) => ({
                  label: t(`reportsPage.orderType.${type}`),
                  value: rupees(netOf((row) => row.orderType === type)),
                })),
              ]}
            />
            <BarChartFigure
              title={t('reportsPage.sources.chart')}
              data={SOURCES.map((source) => ({
                key: source,
                label: t(`reportsPage.source.${source}`),
                value: netOf((row) => row.source === source),
              }))}
              format={rupees}
              axisFormat={(value) => axisRupees(value, t)}
            />
            <Table<SourceRow>
              caption={t('reportsPage.sources.table')}
              columns={[
                textColumn('source', t('reportsPage.columns.source'), (row) =>
                  t(`reportsPage.source.${row.source}`),
                ),
                textColumn('type', t('reportsPage.columns.orderType'), (row) =>
                  t(`reportsPage.orderType.${row.orderType}`),
                ),
                numberColumn('orders', t('reportsPage.sources.orders'), (row) => row.orders),
                moneyColumn('gross', t('reportsPage.sales.gross'), (row) => row.gross),
                moneyColumn('discounts', t('reportsPage.sales.discounts'), (row) => row.discounts),
                moneyColumn('net', t('reportsPage.items.net'), (row) => row.net),
              ]}
              rows={sources.rows}
              rowKey={(row) => `${row.source}|${row.orderType}`}
              empty={t('reportsPage.none')}
            />
          </ReportSection>
        );
      }}
    </ReportBody>
  );
}

type ModeRow = PaymentModesResponse['modes'][number];

/** RPT-005: payments by mode. */
function Payments({ range }: { range: ReportRange }) {
  const t = useT();
  const { api } = useConsole();
  const { data, reload } = useReport((wanted) => api.getPaymentModes({ query: wanted }), range);
  const label = (row: ModeRow) => row.label ?? t(`reportsPage.paymentMode.${row.mode}`);
  return (
    <ReportBody data={data} reload={reload}>
      {(payments) => (
        <ReportSection
          id="report-payments"
          title={t('reportsPage.report.payments')}
          action={<ExportButtons report="PAYMENTS" range={range} />}
        >
          <StatTiles
            stats={[{ label: t('reportsPage.payments.total'), value: rupees(payments.total) }]}
          />
          {payments.modes.length === 0 ? null : (
            <BarChartFigure
              title={t('reportsPage.payments.chart')}
              data={payments.modes.map((row) => ({
                key: `${row.mode}|${row.label ?? ''}`,
                label: label(row),
                value: row.amount,
              }))}
              format={rupees}
              axisFormat={(value) => axisRupees(value, t)}
            />
          )}
          <Table<ModeRow>
            caption={t('reportsPage.payments.table')}
            columns={[
              textColumn('mode', t('reportsPage.columns.mode'), label),
              numberColumn('count', t('reportsPage.columns.count'), (row) => row.count),
              moneyColumn('amount', t('reportsPage.columns.amount'), (row) => row.amount),
            ]}
            rows={payments.modes}
            rowKey={(row) => `${row.mode}|${row.label ?? ''}`}
            empty={t('reportsPage.none')}
          />
        </ReportSection>
      )}
    </ReportBody>
  );
}

export function SalesReport({ slug, range }: { slug: Slug; range: ReportRange }) {
  switch (slug) {
    case 'sales':
      return <SalesSummary range={range} />;
    case 'items':
      return <ItemSales range={range} />;
    case 'sources':
      return <SourceSales range={range} />;
    case 'payments':
      return <Payments range={range} />;
  }
}
