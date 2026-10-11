import {
  type BillingRunView,
  PAYMENT_MODES,
  type PaymentMode,
  type VendorInvoiceView,
} from '@rp/contracts/control-plane';
import { calendarDateOf } from '@rp/domain';
import { Badge, Button, Dialog, Select, Table, TextField, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { day, paiseOf, rupees, rupeeText } from '../app/format.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useApi, useMay } from '../app/services.js';
import { useLoad } from '../app/use-load.js';
import { LoadView } from '../components/LoadView.js';
import { Page } from '../components/Page.js';
import { ReasonDialog } from '../components/ReasonDialog.js';

const STATUSES = ['ISSUED', 'OVERDUE', 'PAID', 'VOID'] as const;
type StatusFilter = (typeof STATUSES)[number];
const STATUS_TONE = { ISSUED: 'info', PAID: 'success', VOID: 'neutral' } as const;

const isStatus = (value: string | null): value is StatusFilter =>
  value !== null && (STATUSES as readonly string[]).includes(value);

function PaymentDialog({
  invoice,
  onClose,
  onSaved,
}: {
  invoice: VendorInvoiceView;
  onClose: () => void;
  onSaved: (paid: VendorInvoiceView) => void;
}) {
  const t = useT();
  const api = useApi();
  const outstanding = invoice.amount - invoice.paid;
  const [amount, setAmount] = useState(() => rupeeText(outstanding));
  const [mode, setMode] = useState<PaymentMode>('UPI');
  const [reference, setReference] = useState('');
  const [receivedOn, setReceivedOn] = useState(() => calendarDateOf(new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const paise = paiseOf(amount);
  const amountError =
    amount.trim() !== '' && (paise === undefined || paise < 1)
      ? t('vendorApp.invoices.amountInvalid')
      : paise !== undefined && paise > outstanding
        ? t('vendorApp.invoices.amountTooMuch', { outstanding: rupees(outstanding) })
        : undefined;
  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={t('vendorApp.invoices.paymentTitle', { number: invoice.number })}
      description={t('vendorApp.invoices.paymentIntro', {
        tenant: invoice.tenantName,
        outstanding: rupees(outstanding),
      })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('vendorApp.actions.cancel')}
          </Button>
          <Button
            loading={busy}
            disabled={busy || paise === undefined || amountError !== undefined || receivedOn === ''}
            onClick={() => {
              if (paise === undefined) return;
              setBusy(true);
              setError(undefined);
              api
                .recordVendorPayment({
                  params: { id: invoice.id },
                  body: {
                    amount: paise,
                    mode,
                    reference: reference.trim() === '' ? null : reference.trim(),
                    receivedOn,
                  },
                })
                .then(onSaved, (failure: unknown) => {
                  setBusy(false);
                  setError(messageOf(failure, t));
                });
            }}
          >
            {t('vendorApp.invoices.record')}
          </Button>
        </>
      }
    >
      <div className="cp-form">
        <TextField
          label={t('vendorApp.invoices.amount')}
          inputMode="decimal"
          value={amount}
          error={amountError}
          onChange={(event) => {
            setAmount(event.target.value);
          }}
        />
        <Select
          label={t('vendorApp.invoices.mode')}
          value={mode}
          options={PAYMENT_MODES.map((value) => ({
            value,
            label: t(`vendorApp.paymentMode.${value}`),
          }))}
          onChange={(event) => {
            setMode(event.target.value as PaymentMode);
          }}
        />
        <TextField
          label={t('vendorApp.invoices.reference')}
          hint={t('vendorApp.invoices.referenceHint')}
          value={reference}
          maxLength={100}
          onChange={(event) => {
            setReference(event.target.value);
          }}
        />
        <TextField
          label={t('vendorApp.invoices.receivedOn')}
          type="date"
          value={receivedOn}
          onChange={(event) => {
            setReceivedOn(event.target.value);
          }}
        />
      </div>
      {error === undefined ? null : (
        <p role="alert" className="cp-notice cp-notice--danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** What a billing run did, in a sentence for the toast. */
export function runSummary(run: BillingRunView, t: ReturnType<typeof useT>): string {
  return t('vendorApp.invoices.runDone', {
    issued: run.issued,
    paymentDue: run.paymentDue,
    grace: run.grace,
    restricted: run.restricted,
  });
}

/**
 * The vendor's invoices to restaurants (VCP-003): filtered by restaurant and status (kept in the
 * address), with what is overdue. Finance records payments received outside the platform (v1),
 * voids an invoice with a reason, and can run billing now.
 */
export function InvoicesScreen() {
  const t = useT();
  const api = useApi();
  const may = useMay();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const tenantId = searchParams.get('tenant') ?? undefined;
  const statusParam = searchParams.get('status');
  const status = isStatus(statusParam) ? statusParam : undefined;
  const { data, reload } = useLoad(
    (signal) => api.listVendorInvoices({ query: { tenantId, status }, signal }),
    `invoices:${tenantId ?? ''}:${status ?? ''}`,
  );
  const [paying, setPaying] = useState<VendorInvoiceView | undefined>();
  const [voiding, setVoiding] = useState<VendorInvoiceView | undefined>();
  const [running, setRunning] = useState(false);
  const manage = may('BILLING_MANAGE');
  const filter = (name: 'tenant' | 'status', value: string | undefined) => {
    const next = new URLSearchParams(searchParams);
    if (value === undefined || value === '') next.delete(name);
    else next.set(name, value);
    setSearchParams(next, { replace: true });
  };

  return (
    <Page
      title={t('vendorApp.invoices.title')}
      intro={t('vendorApp.invoices.intro')}
      actions={
        manage ? (
          <Button
            variant="secondary"
            loading={running}
            onClick={() => {
              setRunning(true);
              api.runBilling().then(
                (run) => {
                  setRunning(false);
                  toast.show({ title: runSummary(run, t), tone: 'success' });
                  reload();
                },
                (failure: unknown) => {
                  setRunning(false);
                  toast.show({ title: messageOf(failure, t), tone: 'danger' });
                },
              );
            }}
          >
            {t('vendorApp.invoices.run')}
          </Button>
        ) : undefined
      }
    >
      <div className="cp-toolbar">
        <Select
          label={t('vendorApp.invoices.status')}
          value={status ?? ''}
          options={[
            { value: '', label: t('vendorApp.invoices.all') },
            ...STATUSES.map((value) => ({ value, label: t(`vendorApp.invoiceStatus.${value}`) })),
          ]}
          onChange={(event) => {
            filter('status', event.target.value);
          }}
        />
        {tenantId === undefined ? null : (
          <Button
            variant="ghost"
            onClick={() => {
              filter('tenant', undefined);
            }}
          >
            {t('vendorApp.invoices.allRestaurants')}
          </Button>
        )}
      </div>
      <LoadView data={data} reload={reload} failed={t('vendorApp.invoices.loadFailed')}>
        {({ invoices }) => (
          <Table
            caption={t('vendorApp.invoices.title')}
            hideCaption
            rows={invoices}
            rowKey={(invoice) => invoice.id}
            empty={t('vendorApp.invoices.empty')}
            columns={[
              {
                key: 'number',
                header: t('vendorApp.invoices.number'),
                cell: (invoice) => invoice.number,
              },
              {
                key: 'tenant',
                header: t('vendorApp.invoices.restaurant'),
                cell: (invoice) => (
                  <Link className="cp-link" to={`/restaurants/${invoice.tenantId}`}>
                    {invoice.tenantName}
                  </Link>
                ),
              },
              {
                key: 'period',
                header: t('vendorApp.invoices.period'),
                cell: (invoice) =>
                  t('vendorApp.invoices.periodRange', {
                    from: day(invoice.periodStart),
                    to: day(invoice.periodEnd),
                  }),
              },
              {
                key: 'amount',
                header: t('vendorApp.invoices.amount'),
                align: 'end',
                cell: (invoice) => rupees(invoice.amount),
              },
              {
                key: 'paid',
                header: t('vendorApp.invoices.paid'),
                align: 'end',
                cell: (invoice) => rupees(invoice.paid),
              },
              {
                key: 'due',
                header: t('vendorApp.invoices.dueOn'),
                cell: (invoice) => day(invoice.dueOn),
              },
              {
                key: 'status',
                header: t('vendorApp.invoices.status'),
                cell: (invoice) =>
                  invoice.daysOverdue > 0 ? (
                    <Badge tone="danger">
                      {t('vendorApp.invoices.overdueDays', { count: invoice.daysOverdue })}
                    </Badge>
                  ) : (
                    <Badge tone={STATUS_TONE[invoice.status]}>
                      {t(`vendorApp.invoiceStatus.${invoice.status}`)}
                    </Badge>
                  ),
              },
              ...(manage
                ? [
                    {
                      key: 'actions',
                      header: t('vendorApp.actions.header'),
                      cell: (invoice: VendorInvoiceView) =>
                        invoice.status === 'ISSUED' ? (
                          <div className="cp-actions">
                            <Button
                              variant="secondary"
                              aria-label={t('vendorApp.invoices.recordFor', {
                                number: invoice.number,
                              })}
                              onClick={() => {
                                setPaying(invoice);
                              }}
                            >
                              {t('vendorApp.invoices.record')}
                            </Button>
                            <Button
                              variant="ghost"
                              aria-label={t('vendorApp.invoices.voidFor', {
                                number: invoice.number,
                              })}
                              onClick={() => {
                                setVoiding(invoice);
                              }}
                            >
                              {t('vendorApp.invoices.void')}
                            </Button>
                          </div>
                        ) : null,
                    },
                  ]
                : []),
            ]}
          />
        )}
      </LoadView>
      {paying === undefined ? null : (
        <PaymentDialog
          invoice={paying}
          onClose={() => {
            setPaying(undefined);
          }}
          onSaved={(paid) => {
            setPaying(undefined);
            toast.show({
              title:
                paid.status === 'PAID'
                  ? t('vendorApp.invoices.paidInFull', { number: paid.number })
                  : t('vendorApp.invoices.paidPart', {
                      number: paid.number,
                      left: rupees(paid.amount - paid.paid),
                    }),
              tone: 'success',
            });
            reload();
          }}
        />
      )}
      <ReasonDialog
        open={voiding !== undefined}
        title={t('vendorApp.invoices.voidTitle', { number: voiding?.number ?? '' })}
        description={t('vendorApp.invoices.voidIntro')}
        confirmLabel={t('vendorApp.invoices.void')}
        tone="danger"
        onClose={() => {
          setVoiding(undefined);
        }}
        onConfirm={async (reason) => {
          await api.voidVendorInvoice({ params: { id: voiding?.id ?? '' }, body: { reason } });
          setVoiding(undefined);
          toast.show({ title: t('vendorApp.invoices.voided'), tone: 'success' });
          reload();
        }}
      />
    </Page>
  );
}
