import type { GstSummaryResponse, InvoiceRegisterResponse } from '@rp/contracts';
import { formatDisplayDate } from '@rp/domain';
import { Badge, Button, Table } from '@rp/ui-web';
import { useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
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

/** The register shows this many invoices at a time; the export has them all. */
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

/** RPT-006: every invoice number in sequence, voided ones included. */
function InvoiceRegister({ range }: { range: ReportRange }) {
  const t = useT();
  const { api } = useConsole();
  const { data, reload } = useReport((wanted) => api.getInvoiceRegister({ query: wanted }), range);
  const [shown, setShown] = useState(REGISTER_PAGE);
  return (
    <ReportBody data={data} reload={reload}>
      {(register) => (
        <ReportSection
          id="report-register"
          title={t('reportsPage.report.register')}
          action={<ExportButton report="INVOICE_REGISTER" range={range} />}
        >
          <StatTiles
            stats={[
              { label: t('reportsPage.register.count'), value: String(register.invoices.length) },
              {
                label: t('reportsPage.register.voided'),
                value: String(
                  register.invoices.filter((invoice) => invoice.status === 'VOIDED').length,
                ),
              },
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
            rows={register.invoices.slice(0, shown)}
            rowKey={(row) => row.invoiceId}
            empty={t('reportsPage.none')}
          />
          {register.invoices.length > shown ? (
            <div className="staff-row__actions">
              <p className="dashboard-section__hint">
                {t('reportsPage.register.showing', {
                  shown,
                  total: register.invoices.length,
                })}
              </p>
              <Button
                variant="secondary"
                onClick={() => {
                  setShown((current) => current + REGISTER_PAGE);
                }}
              >
                {t('reportsPage.register.more')}
              </Button>
            </div>
          ) : null}
        </ReportSection>
      )}
    </ReportBody>
  );
}

export function TaxReport({ slug, range }: { slug: Slug; range: ReportRange }) {
  return slug === 'gst' ? <GstSummary range={range} /> : <InvoiceRegister range={range} />;
}
