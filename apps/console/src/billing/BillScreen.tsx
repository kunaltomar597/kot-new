import type { BillView, InvoiceView } from '@rp/contracts';
import { Badge, Button, Card, ErrorState, Icon, LoadingState, Money, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { useConsole } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useLive } from '../app/use-live.js';
import { CustomerDialog } from './CustomerDialog.js';
import { DiscountDialog } from './DiscountDialog.js';
import { OverrideCancelled, useOverride } from './override.js';
import { ReasonDialog } from './ReasonDialog.js';
import { SplitDialog } from './SplitDialog.js';

type Panel =
  | { readonly kind: 'discount' }
  | { readonly kind: 'revoke'; readonly discountId: string; readonly reason: string }
  | { readonly kind: 'serviceCharge' }
  | { readonly kind: 'customer' }
  | { readonly kind: 'split' }
  | { readonly kind: 'void'; readonly invoice: InvoiceView }
  | { readonly kind: 'edit'; readonly invoice: InvoiceView };

const affectsBill = (type: string) => /^(Order|ItemStatusChanged$|Bill|TableMoved$)/.test(type);

/**
 * The bill on the POS (BILL-001, BILL-005 to BILL-007, BILL-011, BILL-014): the preview priced by
 * the server, discounts with a reason (a manager approves above the cashier's limit, AUTH-011),
 * the service charge, customer details, and printing, which issues the invoice with its number.
 * Printed invoices are listed with their payment.
 */
export function BillScreen({
  billId,
  onBack,
  onPay,
}: {
  billId: string;
  onBack: () => void;
  onPay: (invoiceId: string) => void;
}) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { withOverride, dialog } = useOverride();
  const { data, reload } = useLive(async () => {
    const bill = await controller.api.getBill({ params: { id: billId } });
    const invoices = await Promise.all(
      bill.invoiceIds.map((id) => controller.api.getInvoice({ params: { id } })),
    );
    return { bill, invoices };
  }, affectsBill);
  const [panel, setPanel] = useState<Panel | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const act = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      setPanel(undefined);
      if (done !== undefined) toast.show({ title: done, tone: 'success' });
    } catch (failure) {
      if (!(failure instanceof OverrideCancelled)) setError(messageOf(failure, t));
    } finally {
      setBusy(false);
      reload();
    }
  };

  if (data.status === 'loading') return <LoadingState title={t('states.loading')} />;
  if (data.status === 'error') {
    return (
      <ErrorState
        title={messageOf(data.error, t)}
        action={<Button onClick={reload}>{t('states.retry')}</Button>}
      />
    );
  }
  const { bill, invoices } = data.value;

  const print = () =>
    act(async () => {
      const invoice = await controller.api.issueInvoice({
        params: { id: bill.id },
        body: { seriesId: null },
      });
      await printInvoice(invoice);
    });

  const printInvoice = async (invoice: InvoiceView) => {
    try {
      const result = await controller.api.printInvoice({ params: { id: invoice.id }, body: {} });
      toast.show(
        result.printed
          ? {
              title: result.duplicate
                ? t('billing.reprinted')
                : t('billing.printed', { number: invoice.invoiceNumber }),
              tone: 'success',
            }
          : {
              title: t('billing.notPrinted', {
                number: invoice.invoiceNumber,
                error: result.error ?? '',
              }),
              tone: 'warning',
            },
      );
    } catch (failure) {
      // The invoice exists with its number either way; printing can be tried again.
      toast.show({
        title: t('billing.notPrinted', {
          number: invoice.invoiceNumber,
          error: messageOf(failure, t),
        }),
        tone: 'warning',
      });
    }
  };

  const target =
    bill.tableLabel === null ? t('pos.takeaway') : t('pos.table.title', { table: bill.tableLabel });

  return (
    <section className="pos-order" aria-labelledby="bill-title">
      <header className="pos-order__header">
        <Button variant="ghost" startIcon={<Icon name="close" />} onClick={onBack}>
          {t('pos.backToTables')}
        </Button>
        <h2 id="bill-title" className="pos-floor__heading">
          {t('billing.billFor', { target })}
        </h2>
      </header>
      {error === undefined ? null : (
        <p role="alert" className="console-notice console-notice--danger">
          {error}
        </p>
      )}
      {bill.editingInvoiceId === null ? null : (
        <p className="console-notice" role="status">
          {t('billing.editing', {
            number:
              invoices.find((invoice) => invoice.id === bill.editingInvoiceId)?.invoiceNumber ?? '',
          })}
        </p>
      )}
      <div className="bill">
        <BillPreview bill={bill} />
        <div className="bill__panel">
          {bill.status === 'OPEN' ? (
            <OpenBillActions
              bill={bill}
              busy={busy}
              onPanel={setPanel}
              onPrint={() => {
                void print();
              }}
            />
          ) : null}
          {invoices.length > 0 ? (
            <Card title={t('billing.invoices')} headingLevel={3}>
              <ul className="bill__discounts">
                {invoices.map((invoice) => (
                  <li key={invoice.id} className="bill__discount">
                    <span>
                      {t('billing.invoice', { number: invoice.invoiceNumber })} ·{' '}
                      <Money paise={invoice.grandTotal} />
                    </span>
                    {invoice.status === 'SETTLED' ? (
                      <Badge tone="success" icon={<Icon name="check" />}>
                        {t('billing.settled')}
                      </Badge>
                    ) : null}
                    {invoice.status === 'ISSUED' ? (
                      <Button
                        onClick={() => {
                          onPay(invoice.id);
                        }}
                      >
                        {t('billing.pay')}
                      </Button>
                    ) : null}
                    {invoice.status === 'VOIDED' ? (
                      <Badge tone="danger">
                        {t('billing.voided', { reason: invoice.voidReason ?? '' })}
                      </Badge>
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            void act(() => printInvoice(invoice));
                          }}
                        >
                          {t('billing.reprint')}
                        </Button>
                        {invoice.status === 'ISSUED' && bill.editingInvoiceId === null ? (
                          <Button
                            variant="ghost"
                            aria-label={t('billing.editFor', { number: invoice.invoiceNumber })}
                            disabled={busy}
                            onClick={() => {
                              setPanel({ kind: 'edit', invoice });
                            }}
                          >
                            {t('billing.edit')}
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          aria-label={t('billing.voidFor', { number: invoice.invoiceNumber })}
                          disabled={busy}
                          onClick={() => {
                            setPanel({ kind: 'void', invoice });
                          }}
                        >
                          {t('billing.void')}
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
      {panel?.kind === 'discount' ? (
        <DiscountDialog
          bill={bill}
          busy={busy}
          error={error}
          onClose={() => {
            setPanel(undefined);
          }}
          onApply={(discount) => {
            void act(() =>
              withOverride(
                (overrideToken) =>
                  controller.api.addBillDiscount({
                    params: { id: bill.id },
                    body: discount,
                    ...(overrideToken !== undefined && { overrideToken }),
                  }),
                { entityType: 'bill', entityId: bill.id },
              ),
            );
          }}
        />
      ) : null}
      {panel?.kind === 'revoke' ? (
        <ReasonDialog
          title={t('billing.discount.revokeFor', { reason: panel.reason })}
          label={t('billing.discount.revokeReason')}
          busy={busy}
          error={error}
          onClose={() => {
            setPanel(undefined);
          }}
          onConfirm={(reason) => {
            void act(() =>
              controller.api.revokeBillDiscount({
                params: { id: bill.id, discountId: panel.discountId },
                body: { reason },
              }),
            );
          }}
        />
      ) : null}
      {panel?.kind === 'serviceCharge' ? (
        <ReasonDialog
          title={
            bill.serviceCharge.removed
              ? t('billing.restoreServiceCharge')
              : t('billing.removeServiceCharge')
          }
          label={t('billing.serviceChargeReason')}
          busy={busy}
          error={error}
          onClose={() => {
            setPanel(undefined);
          }}
          onConfirm={(reason) => {
            void act(() =>
              withOverride(
                (overrideToken) =>
                  controller.api.setBillServiceCharge({
                    params: { id: bill.id },
                    body: { removed: !bill.serviceCharge.removed, reason },
                    ...(overrideToken !== undefined && { overrideToken }),
                  }),
                { entityType: 'bill', entityId: bill.id },
              ),
            );
          }}
        />
      ) : null}
      {panel?.kind === 'customer' ? (
        <CustomerDialog
          bill={bill}
          busy={busy}
          error={error}
          onClose={() => {
            setPanel(undefined);
          }}
          onSave={(customer) => {
            void act(() =>
              controller.api.setBillCustomer({ params: { id: bill.id }, body: customer }),
            );
          }}
        />
      ) : null}
      {panel?.kind === 'split' ? (
        <SplitDialog
          bill={bill}
          busy={busy}
          error={error}
          onClose={() => {
            setPanel(undefined);
          }}
          onSplit={(request) => {
            void act(
              async () => {
                const result = await controller.api.splitBill({
                  params: { id: bill.id },
                  body: request,
                });
                for (const invoice of result.invoices) await printInvoice(invoice);
              },
              t('billing.split.done', {
                count: request.mode === 'EQUAL' ? request.parts : request.parts.length,
              }),
            );
          }}
        />
      ) : null}
      {panel?.kind === 'void' ? (
        <ReasonDialog
          title={t('billing.voidFor', { number: panel.invoice.invoiceNumber })}
          label={t('billing.voidReason')}
          busy={busy}
          error={error}
          onClose={() => {
            setPanel(undefined);
          }}
          onConfirm={(reason) => {
            void act(
              () =>
                withOverride(
                  (overrideToken) =>
                    controller.api.voidInvoice({
                      params: { id: panel.invoice.id },
                      body: { reason },
                      ...(overrideToken !== undefined && { overrideToken }),
                    }),
                  { entityType: 'invoice', entityId: panel.invoice.id },
                ),
              t('billing.voidedToast', { number: panel.invoice.invoiceNumber }),
            );
          }}
        />
      ) : null}
      {panel?.kind === 'edit' ? (
        <ReasonDialog
          title={t('billing.editFor', { number: panel.invoice.invoiceNumber })}
          label={t('billing.editReason')}
          busy={busy}
          error={error}
          onClose={() => {
            setPanel(undefined);
          }}
          onConfirm={(reason) => {
            void act(() =>
              withOverride(
                (overrideToken) =>
                  controller.api.reopenInvoice({
                    params: { id: panel.invoice.id },
                    body: { reason },
                    ...(overrideToken !== undefined && { overrideToken }),
                  }),
                { entityType: 'invoice', entityId: panel.invoice.id },
              ),
            );
          }}
        />
      ) : null}
      {dialog}
    </section>
  );
}

function BillPreview({ bill }: { bill: BillView }) {
  const t = useT();
  return (
    <Card title={t('billing.lines')} headingLevel={3}>
      <table className="rp-table">
        <thead>
          <tr>
            <th scope="col">{t('billing.item')}</th>
            <th scope="col">{t('billing.quantity')}</th>
            <th scope="col">{t('billing.amount')}</th>
          </tr>
        </thead>
        <tbody>
          {bill.lines.map((line) => (
            <tr key={line.orderItemId}>
              <td>
                {line.description}
                {line.complimentary ? (
                  <>
                    {' '}
                    <Badge tone="info">{t('billing.complimentary')}</Badge>
                  </>
                ) : null}
              </td>
              <td>{line.quantity}</td>
              <td>
                <Money paise={line.grossAmount - line.itemDiscount} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="bill__totals">
        <dt>{t('billing.subtotal')}</dt>
        <dd>
          <Money paise={bill.subtotal} />
        </dd>
        {bill.discountTotal > 0 ? (
          <>
            <dt>{t('billing.discounts')}</dt>
            <dd>
              <Money paise={-bill.discountTotal} signTone />
            </dd>
          </>
        ) : null}
        {bill.serviceCharge.enabled && !bill.serviceCharge.removed ? (
          <>
            <dt>
              {t('billing.serviceCharge', {
                rate: (bill.serviceCharge.rateBp / 100).toFixed(2).replace(/\.00$/, ''),
              })}
            </dt>
            <dd>
              <Money paise={bill.serviceCharge.amount} />
            </dd>
          </>
        ) : null}
        {bill.taxLines.flatMap((line) =>
          line.components.map((component) => (
            <FragmentRow
              key={`${line.taxGroupId}-${line.source}-${component.code}`}
              label={`${component.code} ${(component.rateBp / 100).toFixed(2).replace(/\.?0+$/, '')}%`}
              paise={component.amount}
            />
          )),
        )}
        {bill.roundOff === 0 ? null : (
          <FragmentRow label={t('billing.roundOff')} paise={bill.roundOff} />
        )}
        <dt className="bill__grand">{t('billing.total')}</dt>
        <dd className="bill__grand">
          <Money paise={bill.grandTotal} size="lg" strong />
        </dd>
      </dl>
    </Card>
  );
}

function FragmentRow({ label, paise }: { label: string; paise: number }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <Money paise={paise} />
      </dd>
    </>
  );
}

function OpenBillActions({
  bill,
  busy,
  onPanel,
  onPrint,
}: {
  bill: BillView;
  busy: boolean;
  onPanel: (panel: Panel) => void;
  onPrint: () => void;
}) {
  const t = useT();
  return (
    <>
      <Card title={t('billing.discounts')} headingLevel={3}>
        <ul className="bill__discounts">
          {bill.discounts.map((discount) => (
            <li key={discount.id} className="bill__discount">
              <span>
                {discount.reason} · <Money paise={-discount.amount} signTone />
              </span>
              <Button
                variant="ghost"
                aria-label={t('billing.discount.revokeFor', { reason: discount.reason })}
                disabled={busy}
                onClick={() => {
                  onPanel({ kind: 'revoke', discountId: discount.id, reason: discount.reason });
                }}
              >
                {t('billing.discount.revoke')}
              </Button>
            </li>
          ))}
        </ul>
        <div className="bill__actions">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              onPanel({ kind: 'discount' });
            }}
          >
            {t('billing.addDiscount')}
          </Button>
          <Button
            variant="secondary"
            disabled={busy || bill.lines.length === 0}
            onClick={() => {
              onPanel({ kind: 'split' });
            }}
          >
            {t('billing.split.open')}
          </Button>
          {bill.serviceCharge.enabled ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                onPanel({ kind: 'serviceCharge' });
              }}
            >
              {bill.serviceCharge.removed
                ? t('billing.restoreServiceCharge')
                : t('billing.removeServiceCharge')}
            </Button>
          ) : null}
        </div>
      </Card>
      <Card
        title={t('billing.customer.title')}
        headingLevel={3}
        actions={
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              onPanel({ kind: 'customer' });
            }}
          >
            {t('billing.customer.edit')}
          </Button>
        }
      >
        <p>
          {[bill.customer.name, bill.customer.phone, bill.customer.gstin]
            .filter((part): part is string => part !== null)
            .join(' · ')}
        </p>
      </Card>
      <Button size="lg" loading={busy} disabled={bill.lines.length === 0} onClick={onPrint}>
        {t('billing.printBill')}
      </Button>
    </>
  );
}
