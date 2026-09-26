import type { DayEndPreview } from '@rp/contracts';
import { Button, Card, ErrorState, Icon, LoadingState, Money, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { useConsole } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useLive } from '../app/use-live.js';

const affectsDay = (type: string) => /^(Bill|Order|Table|ItemStatusChanged$)/.test(type);

/**
 * Closing the business day (BILL-013): the Z-report of the day so far, what blocks closing (open
 * shifts, unpaid takeaway bills, open tables, which the manager may carry forward), and the close.
 */
export function DayEndScreen({ onBack }: { onBack: () => void }) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { data, reload } = useLive(() => controller.api.previewDayEnd(), affectsDay);
  const [carryForward, setCarryForward] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const close = async (preview: DayEndPreview) => {
    setBusy(true);
    setError(undefined);
    try {
      await controller.api.closeDay({
        body: { businessDate: preview.businessDate, carryForwardTables: carryForward },
      });
      toast.show({
        title: t('dayEnd.closedToast', { date: preview.businessDate }),
        tone: 'success',
      });
    } catch (failure) {
      setError(messageOf(failure, t));
    } finally {
      setBusy(false);
      reload();
    }
  };

  return (
    <section className="pos-order" aria-labelledby="day-end-title">
      <header className="pos-order__header">
        <Button variant="ghost" startIcon={<Icon name="close" />} onClick={onBack}>
          {t('pos.backToTables')}
        </Button>
        <h2 id="day-end-title" className="pos-floor__heading">
          {data.status === 'ready'
            ? t('dayEnd.title', { date: data.value.businessDate })
            : t('dayEnd.open')}
        </h2>
      </header>
      {data.status === 'loading' ? <LoadingState title={t('states.loading')} /> : null}
      {data.status === 'error' ? (
        <ErrorState
          title={messageOf(data.error, t)}
          action={<Button onClick={reload}>{t('states.retry')}</Button>}
        />
      ) : null}
      {data.status === 'ready' ? (
        <div className="bill">
          <ZReport preview={data.value} />
          <div className="bill__panel">
            {error === undefined ? null : (
              <p role="alert" className="console-notice console-notice--danger">
                {error}
              </p>
            )}
            <Blockers preview={data.value} />
            {data.value.status === 'CLOSED' ? (
              <p className="console-notice">{t('dayEnd.closed')}</p>
            ) : (
              <>
                {data.value.blockers.openTables.length > 0 ? (
                  <label className="console-check">
                    <input
                      type="checkbox"
                      checked={carryForward}
                      onChange={(event) => {
                        setCarryForward(event.target.checked);
                      }}
                    />
                    {t('dayEnd.carryForward')}
                  </label>
                ) : null}
                <Button
                  variant="danger"
                  size="lg"
                  loading={busy}
                  onClick={() => {
                    void close(data.value);
                  }}
                >
                  {t('dayEnd.close')}
                </Button>
              </>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Blockers({ preview }: { preview: DayEndPreview }) {
  const t = useT();
  const { openShifts, openTables, unsettledInvoices } = preview.blockers;
  const none = openShifts.length + openTables.length + unsettledInvoices.length === 0;
  return (
    <Card title={t('dayEnd.blockers')} headingLevel={3}>
      {none ? <p>{t('dayEnd.noBlockers')}</p> : null}
      <ul className="bill__discounts">
        {openShifts.length > 0 ? (
          <li>{t('dayEnd.openShifts', { count: openShifts.length })}</li>
        ) : null}
        {openTables.length > 0 ? (
          <li>
            {t('dayEnd.openTables', {
              tables: openTables.map((table) => table.tableLabel).join(', '),
            })}
          </li>
        ) : null}
        {unsettledInvoices.length > 0 ? (
          <li>
            {t('dayEnd.unsettled', {
              invoices: unsettledInvoices.map((invoice) => invoice.invoiceNumber).join(', '),
            })}
          </li>
        ) : null}
      </ul>
    </Card>
  );
}

function ZReport({ preview }: { preview: DayEndPreview }) {
  const t = useT();
  const { report } = preview;
  return (
    <Card title={t('dayEnd.report')} headingLevel={3}>
      <dl className="bill__totals">
        <dt>{t('dayEnd.orders')}</dt>
        <dd>{report.orders}</dd>
        <dt>{t('dayEnd.invoices')}</dt>
        <dd>{report.invoices.count}</dd>
        {report.invoices.voided.length > 0 ? (
          <>
            <dt>{t('dayEnd.voidedInvoices')}</dt>
            <dd>{report.invoices.voided.join(', ')}</dd>
          </>
        ) : null}
        <Row label={t('dayEnd.grossSales')} paise={report.grossSales} />
        <Row label={t('dayEnd.discounts')} paise={-report.discounts} />
        <Row label={t('dayEnd.serviceCharge')} paise={report.serviceCharge} />
        <Row label={t('dayEnd.tax')} paise={report.taxTotal} />
        <dt className="bill__grand">{t('dayEnd.netSales')}</dt>
        <dd className="bill__grand">
          <Money paise={report.netSales} strong />
        </dd>
        <Row label={t('dayEnd.settledSales')} paise={report.settledSales} />
      </dl>
      <h4>{t('dayEnd.payments')}</h4>
      <dl className="bill__totals">
        {report.payments.map((payment) => (
          <Row
            key={`${payment.mode}-${payment.label ?? ''}`}
            label={`${payment.label ?? t(`payment.modes.${payment.mode}`)} (${String(payment.count)})`}
            paise={payment.amount}
          />
        ))}
        <Row label={t('dayEnd.variance')} paise={report.totalVariance} />
      </dl>
    </Card>
  );
}

function Row({ label, paise }: { label: string; paise: number }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <Money paise={paise} signTone />
      </dd>
    </>
  );
}
