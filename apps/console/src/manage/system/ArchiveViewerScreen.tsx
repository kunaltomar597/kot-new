import type {
  ArchivedDaysResponse,
  ArchivedInvoiceListResponse,
  ArchivedInvoiceResponse,
} from '@rp/contracts';
import { formatDisplayDate, formatRupees } from '@rp/domain';
import { Button, Dialog, ErrorState, LoadingState, Table, TextField, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';

type Found = ArchivedInvoiceListResponse['invoices'];

/** One archived invoice as it was printed, to read or print again. */
function PrintedInvoice({
  invoice,
  onClose,
}: {
  invoice: ArchivedInvoiceResponse;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('archiveViewer.invoiceTitle', { number: invoice.invoice.invoiceNumber })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('archiveViewer.close')}
          </Button>
          <Button
            onClick={() => {
              globalThis.print();
            }}
          >
            {t('archiveViewer.print')}
          </Button>
        </>
      }
    >
      <figure className="archive-invoice__figure" aria-label={t('archiveViewer.printed')}>
        <pre className="archive-invoice">{invoice.printed.join('\n')}</pre>
      </figure>
    </Dialog>
  );
}

/**
 * An archived year opened read-only (DATA-009, P7-06c): its daily report, and its invoices by date
 * or number, each shown and printed as it was. Nothing is restored into the live database.
 */
export function ArchiveViewerScreen() {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { id = '' } = useParams();
  const { data, reload } = useLive<ArchivedDaysResponse>(
    () => controller.api.getArchivedDays({ params: { id } }),
    () => false,
  );
  const [date, setDate] = useState('');
  const [number, setNumber] = useState('');
  const [found, setFound] = useState<Found | undefined>();
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<ArchivedInvoiceResponse | undefined>();

  const search = (query: { date: string } | { number: string }) => {
    setBusy(true);
    controller.api.listArchivedInvoices({ params: { id }, query }).then(
      (result) => {
        setBusy(false);
        setFound(result.invoices);
      },
      (failure: unknown) => {
        setBusy(false);
        toast.show({ title: messageOf(failure, t), tone: 'danger' });
      },
    );
  };

  let report;
  if (data.status === 'loading') {
    report = <LoadingState title={t('archiveViewer.reading')} />;
  } else if (data.status === 'error') {
    report = (
      <ErrorState
        title={t('archiveViewer.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const view = data.value;
    report = (
      <>
        <p className="dashboard-section__hint">
          {t('archiveViewer.summary', {
            year: view.financialYear,
            restaurants: view.restaurants.join(', '),
            invoices: view.totals.invoices,
            sales: formatRupees(view.totals.sales),
            tax: formatRupees(view.totals.tax),
          })}
        </p>
        <Table
          caption={t('archiveViewer.days')}
          rows={view.days}
          rowKey={(day) => day.date}
          columns={[
            {
              key: 'date',
              header: t('archiveViewer.column.date'),
              cell: (day) => formatDisplayDate(day.date),
            },
            {
              key: 'invoices',
              header: t('archiveViewer.column.invoices'),
              align: 'end',
              cell: (day) => day.invoices,
            },
            {
              key: 'voided',
              header: t('archiveViewer.column.voided'),
              align: 'end',
              cell: (day) => day.voided,
            },
            {
              key: 'sales',
              header: t('archiveViewer.column.sales'),
              align: 'end',
              cell: (day) => formatRupees(day.sales),
            },
            {
              key: 'tax',
              header: t('archiveViewer.column.tax'),
              align: 'end',
              cell: (day) => formatRupees(day.tax),
            },
          ]}
        />
      </>
    );
  }

  return (
    <section className="dashboard-section" aria-labelledby="archive-viewer">
      <Link className="console-link" to="/manage/system">
        {t('archiveViewer.back')}
      </Link>
      <h2 id="archive-viewer" className="dashboard-section__heading">
        {t('archiveViewer.title')}
      </h2>
      <p className="dashboard-section__hint">{t('archiveViewer.intro')}</p>
      <form
        className="menu-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          if (number.trim() !== '') search({ number: number.trim() });
          else if (date !== '') search({ date });
        }}
      >
        <TextField
          label={t('archiveViewer.date')}
          type="date"
          value={date}
          onChange={(event) => {
            setDate(event.target.value);
            setNumber('');
          }}
        />
        <TextField
          label={t('archiveViewer.number')}
          value={number}
          maxLength={40}
          onChange={(event) => {
            setNumber(event.target.value);
            setDate('');
          }}
        />
        <Button
          type="submit"
          loading={busy}
          disabled={busy || (date === '' && number.trim() === '')}
        >
          {t('archiveViewer.find')}
        </Button>
      </form>
      {found === undefined ? null : (
        <Table
          caption={t('archiveViewer.found')}
          rows={found}
          rowKey={(invoice) => invoice.id}
          empty={t('archiveViewer.none')}
          columns={[
            {
              key: 'number',
              header: t('archiveViewer.column.number'),
              cell: (invoice) => (
                <Button
                  variant="ghost"
                  onClick={() => {
                    controller.api
                      .getArchivedInvoice({ params: { id, invoiceId: invoice.id } })
                      .then(setOpened, (failure: unknown) => {
                        toast.show({ title: messageOf(failure, t), tone: 'danger' });
                      });
                  }}
                >
                  {invoice.invoiceNumber}
                </Button>
              ),
            },
            {
              key: 'date',
              header: t('archiveViewer.column.date'),
              cell: (invoice) => formatDisplayDate(invoice.invoiceDate),
            },
            {
              key: 'status',
              header: t('archiveViewer.column.status'),
              cell: (invoice) => t(`reportsPage.invoiceStatus.${invoice.status}`),
            },
            {
              key: 'total',
              header: t('archiveViewer.column.total'),
              align: 'end',
              cell: (invoice) => formatRupees(invoice.grandTotal),
            },
          ]}
        />
      )}
      {report}
      {opened === undefined ? null : (
        <PrintedInvoice
          invoice={opened}
          onClose={() => {
            setOpened(undefined);
          }}
        />
      )}
    </section>
  );
}
