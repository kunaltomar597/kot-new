import type {
  CancellationReportResponse,
  DiscountReportResponse,
  ReprintReportResponse,
} from '@rp/contracts';
import { displayDateTime, formatDisplayDate } from '@rp/domain';
import { Badge, Table } from '@rp/ui-web';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { percent, type ReportRange, rupees } from './report-view.js';
import {
  ExportButtons,
  moneyColumn,
  nameOf,
  numberColumn,
  OrderLink,
  ReportBody,
  ReportSection,
  StatTiles,
  textColumn,
} from './ReportParts.js';
import { useReport } from './use-report.js';

type Slug = 'discounts' | 'cancellations' | 'reprints';
type DiscountRow = DiscountReportResponse['discounts'][number];
type ItemEndRow = CancellationReportResponse['items'][number];
type BillVoidRow = CancellationReportResponse['bills'][number];
type ReprintRow = ReprintReportResponse['events'][number];

const when = (at: string) => {
  const { date, time } = displayDateTime(new Date(at));
  return `${date} ${time}`;
};

/** RPT-007: discounts and complimentary dishes, who gave them, who approved and why. */
function Discounts({ range }: { range: ReportRange }) {
  const t = useT();
  const { api } = useConsole();
  const { data, reload } = useReport((wanted) => api.getDiscountReport({ query: wanted }), range);
  return (
    <ReportBody data={data} reload={reload}>
      {(report) => (
        <ReportSection
          id="report-discounts"
          title={t('reportsPage.report.discounts')}
          action={<ExportButtons report="DISCOUNTS" range={range} />}
        >
          <StatTiles
            stats={[
              { label: t('reportsPage.discounts.count'), value: String(report.totals.count) },
              { label: t('reportsPage.discounts.amount'), value: rupees(report.totals.amount) },
              {
                label: t('reportsPage.discounts.complimentary'),
                value: t('reportsPage.discounts.complimentaryValue', {
                  count: report.totals.complimentaryCount,
                  amount: rupees(report.totals.complimentaryAmount),
                }),
              },
            ]}
          />
          <Table<DiscountRow>
            caption={t('reportsPage.discounts.table')}
            columns={[
              textColumn('date', t('reportsPage.columns.date'), (row) =>
                formatDisplayDate(row.businessDate),
              ),
              textColumn('invoice', t('reportsPage.columns.invoice'), (row) => row.invoiceNumber),
              textColumn(
                'what',
                t('reportsPage.discounts.what'),
                (row) => row.item ?? t('reportsPage.discounts.wholeBill'),
              ),
              textColumn('kind', t('reportsPage.discounts.kind'), (row) =>
                row.complimentary ? (
                  <Badge tone="info">{t('reportsPage.discounts.free')}</Badge>
                ) : row.kind === 'PERCENT' && row.rateBp !== null ? (
                  percent(row.rateBp)
                ) : (
                  t('reportsPage.discounts.flat')
                ),
              ),
              moneyColumn('amount', t('reportsPage.columns.amount'), (row) => row.amount),
              textColumn('reason', t('reportsPage.columns.reason'), (row) => row.reason),
              textColumn('by', t('reportsPage.columns.by'), (row) => nameOf(row.appliedBy)),
              textColumn('approved', t('reportsPage.columns.approvedBy'), (row) =>
                nameOf(row.approvedBy),
              ),
              textColumn('order', t('reportsPage.columns.order'), (row) => (
                <OrderLink orderId={row.orderId} />
              )),
            ]}
            rows={report.discounts}
            rowKey={(row) => row.discountId}
            empty={t('reportsPage.none')}
          />
        </ReportSection>
      )}
    </ReportBody>
  );
}

/** RPT-008: dishes cancelled or voided with the stage they had reached, and bills voided. */
function Cancellations({ range }: { range: ReportRange }) {
  const t = useT();
  const { api } = useConsole();
  const { data, reload } = useReport(
    (wanted) => api.getCancellationReport({ query: wanted }),
    range,
  );
  return (
    <ReportBody data={data} reload={reload}>
      {(report) => (
        <ReportSection
          id="report-cancellations"
          title={t('reportsPage.report.cancellations')}
          action={<ExportButtons report="CANCELLATIONS" range={range} />}
        >
          <StatTiles
            stats={[
              {
                label: t('reportsPage.cancellations.cancelled'),
                value: t('reportsPage.countAndAmount', {
                  count: report.totals.cancelledCount,
                  amount: rupees(report.totals.cancelledValue),
                }),
              },
              {
                label: t('reportsPage.cancellations.voided'),
                value: t('reportsPage.countAndAmount', {
                  count: report.totals.voidedCount,
                  amount: rupees(report.totals.voidedValue),
                }),
              },
              {
                label: t('reportsPage.cancellations.wastage'),
                value: rupees(report.totals.wastageValue),
              },
              {
                label: t('reportsPage.cancellations.bills'),
                value: t('reportsPage.countAndAmount', {
                  count: report.totals.billCount,
                  amount: rupees(report.totals.billValue),
                }),
              },
            ]}
          />
          <Table<ItemEndRow>
            caption={t('reportsPage.cancellations.items')}
            columns={[
              textColumn('when', t('reportsPage.columns.when'), (row) => when(row.at)),
              textColumn('dish', t('reportsPage.columns.dish'), (row) => row.item),
              textColumn('kind', t('reportsPage.cancellations.kind'), (row) =>
                row.wastage ? (
                  <Badge tone="warning">{t('reportsPage.cancellations.wasted')}</Badge>
                ) : (
                  t(`reportsPage.cancellations.kinds.${row.kind}`)
                ),
              ),
              textColumn('stage', t('reportsPage.cancellations.stage'), (row) =>
                row.stage === null ? '–' : t(`reportsPage.itemState.${row.stage}`),
              ),
              numberColumn('quantity', t('reportsPage.columns.quantity'), (row) => row.quantity),
              moneyColumn('value', t('reportsPage.columns.value'), (row) => row.value),
              textColumn('by', t('reportsPage.columns.by'), (row) => nameOf(row.by)),
              textColumn('approved', t('reportsPage.columns.approvedBy'), (row) =>
                nameOf(row.approvedBy),
              ),
              textColumn('reason', t('reportsPage.columns.reason'), (row) => row.reason ?? '–'),
              textColumn('order', t('reportsPage.columns.order'), (row) => (
                <OrderLink orderId={row.orderId} />
              )),
            ]}
            rows={report.items}
            rowKey={(row) => row.auditId}
            empty={t('reportsPage.none')}
          />
          <Table<BillVoidRow>
            caption={t('reportsPage.cancellations.billsTable')}
            columns={[
              textColumn('when', t('reportsPage.columns.when'), (row) => when(row.at)),
              textColumn('invoice', t('reportsPage.columns.invoice'), (row) => row.invoiceNumber),
              moneyColumn('value', t('reportsPage.columns.value'), (row) => row.value),
              textColumn('by', t('reportsPage.columns.by'), (row) => nameOf(row.by)),
              textColumn('approved', t('reportsPage.columns.approvedBy'), (row) =>
                nameOf(row.approvedBy),
              ),
              textColumn('reason', t('reportsPage.columns.reason'), (row) => row.reason ?? '–'),
            ]}
            rows={report.bills}
            rowKey={(row) => row.auditId}
            empty={t('reportsPage.none')}
          />
        </ReportSection>
      )}
    </ReportBody>
  );
}

/** RPT-009: kitchen tickets and bills printed again, and bills changed after printing. */
function Reprints({ range }: { range: ReportRange }) {
  const t = useT();
  const { api } = useConsole();
  const { data, reload } = useReport((wanted) => api.getReprintReport({ query: wanted }), range);
  const total = (value: number | null) => (value === null ? '–' : rupees(value));
  return (
    <ReportBody data={data} reload={reload}>
      {(report) => (
        <ReportSection
          id="report-reprints"
          title={t('reportsPage.report.reprints')}
          action={<ExportButtons report="REPRINTS" range={range} />}
        >
          <StatTiles
            stats={[
              { label: t('reportsPage.reprints.kot'), value: String(report.totals.kotReprints) },
              { label: t('reportsPage.reprints.bill'), value: String(report.totals.billReprints) },
              { label: t('reportsPage.reprints.edits'), value: String(report.totals.billEdits) },
            ]}
          />
          <Table<ReprintRow>
            caption={t('reportsPage.reprints.table')}
            columns={[
              textColumn('when', t('reportsPage.columns.when'), (row) => when(row.at)),
              textColumn('kind', t('reportsPage.reprints.kind'), (row) =>
                t(`reportsPage.reprints.kinds.${row.kind}`),
              ),
              textColumn('reference', t('reportsPage.reprints.reference'), (row) => row.reference),
              textColumn('change', t('reportsPage.reprints.change'), (row) =>
                row.kind === 'BILL_EDIT'
                  ? t('reportsPage.reprints.fromTo', {
                      before: total(row.before),
                      after: total(row.after),
                    })
                  : '–',
              ),
              textColumn('by', t('reportsPage.columns.by'), (row) => nameOf(row.by)),
              textColumn('approved', t('reportsPage.columns.approvedBy'), (row) =>
                nameOf(row.approvedBy),
              ),
              textColumn('reason', t('reportsPage.columns.reason'), (row) => row.reason ?? '–'),
              textColumn('order', t('reportsPage.columns.order'), (row) => (
                <OrderLink orderId={row.orderId} />
              )),
            ]}
            rows={report.events}
            rowKey={(row) => row.auditId}
            empty={t('reportsPage.none')}
          />
        </ReportSection>
      )}
    </ReportBody>
  );
}

export function ControlReport({ slug, range }: { slug: Slug; range: ReportRange }) {
  switch (slug) {
    case 'discounts':
      return <Discounts range={range} />;
    case 'cancellations':
      return <Cancellations range={range} />;
    case 'reprints':
      return <Reprints range={range} />;
  }
}
