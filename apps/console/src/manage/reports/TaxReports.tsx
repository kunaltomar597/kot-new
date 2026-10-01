import type { GstSummaryResponse, InvoiceRegisterResponse } from '@rp/contracts';
import { formatDisplayDate } from '@rp/domain';
import { Badge, Button, Table, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { percent, type ReportRange, rupees } from './report-view.js';
import {
  ExportButton,
  moneyColumn,
  ReportBody,
  ReportSection,
  StatTiles,
  textColumn,
} from './ReportParts.js';
import { useReport } from './use-report.js';

type Slug = 'gst' | 'register';
type GstRow = GstSummaryResponse['rows'][number];
type InvoiceRow = InvoiceRegisterResponse['invoices'][number];

/** The register reads this many invoices at a time; the export has them all. */
export const REGISTER_PAGE = 200;

/** RPT-006: taxable value and each tax by SAC and rate, for the restaurant's CA. */
function GstSummary({ range }: { range: ReportRange }) {
  const t = useT();
  const { api } = useConsole();
  const { data, reload } = useReport((wanted) => api.getGstSummary({ query: wanted }), range);
  return (
    <ReportBody data={data} reload={reload}>
      {(gst) => {
        const codes = Object.keys(gst.totals.components).sort();
        return (
          <ReportSection
            id="report-gst"
            title={t('reportsPage.report.gst')}
            action={<ExportButton report="GST" range={range} />}
          >
            <StatTiles
              stats={[
                { label: t('reportsPage.gst.taxable'), value: rupees(gst.totals.taxableValue) },
                ...codes.map((code) => ({
                  label: code,
                  value: rupees(gst.totals.components[code] ?? 0),
                })),
                { label: t('reportsPage.gst.taxTotal'), value: rupees(gst.totals.taxTotal) },
              ]}
            />
            <Table<GstRow>
              caption={t('reportsPage.gst.table')}
              columns={[
                textColumn('sac', t('reportsPage.columns.sac'), (row) => row.sacCode ?? '–'),
                textColumn('rate', t('reportsPage.columns.rate'), (row) => percent(row.rateBp)),
                moneyColumn('taxable', t('reportsPage.gst.taxable'), (row) => row.taxableValue),
                ...codes.map((code) =>
                  moneyColumn<GstRow>(`code-${code}`, code, (row) => row.components[code] ?? 0),
                ),
                moneyColumn('total', t('reportsPage.gst.taxTotal'), (row) => row.taxTotal),
              ]}
              rows={gst.rows}
              rowKey={(row) => `${row.sacCode ?? ''}|${String(row.rateBp)}`}
              empty={t('reportsPage.none')}
            />
          </ReportSection>
        );
      }}
    </ReportBody>
  );
}

/** RPT-006: every invoice number in sequence, voided ones included, a page at a time. */
function InvoiceRegister({ range }: { range: ReportRange }) {
  const t = useT();
  const { api } = useConsole();
  const toast = useToast();
  const { data, reload } = useReport(
    (wanted) => api.getInvoiceRegister({ query: { ...wanted, offset: 0, limit: REGISTER_PAGE } }),
    range,
  );
  // The pages read after the first, for this range; another range starts from its first page.
  const [more, setMore] = useState<
    | { readonly key: string; readonly invoices: InvoiceRow[]; readonly next: number | null }
    | undefined
  >();
  const [loadingMore, setLoadingMore] = useState(false);
  const key = `${range.from}|${range.to}`;
  return (
    <ReportBody data={data} reload={reload}>
      {(register) => {
        const extra = more?.key === key ? more : undefined;
        const invoices = [...register.invoices, ...(extra?.invoices ?? [])];
        const next = extra === undefined ? register.nextOffset : extra.next;
        return (
          <ReportSection
            id="report-register"
            title={t('reportsPage.report.register')}
            action={<ExportButton report="INVOICE_REGISTER" range={range} />}
          >
            <StatTiles
              stats={[
                { label: t('reportsPage.register.count'), value: String(register.total) },
                { label: t('reportsPage.register.voided'), value: String(register.voided) },
              ]}
            />
            <Table<InvoiceRow>
              caption={t('reportsPage.register.table')}
              columns={[
                textColumn('number', t('reportsPage.columns.invoice'), (row) => row.invoiceNumber),
                textColumn('date', t('reportsPage.columns.date'), (row) =>
                  formatDisplayDate(row.invoiceDate),
                ),
                textColumn('status', t('reportsPage.columns.status'), (row) =>
                  row.status === 'VOIDED' ? (
                    <Badge tone="danger">{t('reportsPage.invoiceStatus.VOIDED')}</Badge>
                  ) : (
                    t(`reportsPage.invoiceStatus.${row.status}`)
                  ),
                ),
                textColumn('customer', t('reportsPage.columns.customer'), (row) =>
                  [row.customerName, row.customerGstin].filter(Boolean).join(' · '),
                ),
                moneyColumn('taxable', t('reportsPage.gst.taxable'), (row) => row.taxableValue),
                moneyColumn('tax', t('reportsPage.sales.tax'), (row) => row.taxTotal),
                moneyColumn('total', t('reportsPage.columns.total'), (row) => row.grandTotal),
                textColumn('note', t('reportsPage.columns.note'), (row) =>
                  [
                    row.voidReason,
                    row.replacesInvoiceNumber === null
                      ? null
                      : t('reportsPage.register.replaces', { number: row.replacesInvoiceNumber }),
                  ]
                    .filter(Boolean)
                    .join(' · '),
                ),
              ]}
              rows={invoices}
              rowKey={(row) => row.invoiceId}
              empty={t('reportsPage.none')}
            />
            {next === null ? null : (
              <div className="staff-row__actions">
                <p className="dashboard-section__hint">
                  {t('reportsPage.register.showing', {
                    shown: invoices.length,
                    total: register.total,
                  })}
                </p>
                <Button
                  variant="secondary"
                  loading={loadingMore}
                  onClick={() => {
                    setLoadingMore(true);
                    api
                      .getInvoiceRegister({
                        query: { ...range, offset: next, limit: REGISTER_PAGE },
                      })
                      .then(
                        (page) => {
                          setMore({
                            key,
                            invoices: [...(extra?.invoices ?? []), ...page.invoices],
                            next: page.nextOffset,
                          });
                        },
                        (failure: unknown) => {
                          toast.show({ title: messageOf(failure, t), tone: 'danger' });
                        },
                      )
                      .finally(() => {
                        setLoadingMore(false);
                      });
                  }}
                >
                  {t('reportsPage.register.more')}
                </Button>
              </div>
            )}
          </ReportSection>
        );
      }}
    </ReportBody>
  );
}

export function TaxReport({ slug, range }: { slug: Slug; range: ReportRange }) {
  return slug === 'gst' ? <GstSummary range={range} /> : <InvoiceRegister range={range} />;
}
