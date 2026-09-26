import { ApiRequestError } from '@rp/api-client';
import type { InvoicePaymentsView } from '@rp/contracts';
import { formatRupees } from '@rp/domain';
import {
  Button,
  Card,
  ErrorState,
  Icon,
  IconButton,
  LoadingState,
  Money,
  Select,
  TextField,
  useToast,
} from '@rp/ui-web';
import { useState } from 'react';
import { useConsole } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useLive } from '../app/use-live.js';
import {
  changeFor,
  inputFromPaise,
  paiseFromInput,
  type PlannedPayment,
  stillToPay,
} from './money-input.js';

const MODES = ['CASH', 'UPI', 'CARD', 'OTHER'] as const;
const never = () => false;
const newKey = () => crypto.randomUUID();

/**
 * Taking payment for an invoice (BILL-008): one or several payments across cash, UPI, card and
 * the restaurant's other modes, with the change for cash. The payments are recorded together with
 * one idempotency key, so a retry after a lost answer never records them twice.
 */
export function PaymentScreen({
  invoiceId,
  onBack,
  onDone,
  onOpenShift,
}: {
  invoiceId: string;
  onBack: () => void;
  onDone: () => void;
  onOpenShift: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const { data, reload } = useLive(
    () => controller.api.getInvoicePayments({ params: { id: invoiceId } }),
    never,
  );

  return (
    <section className="pos-order" aria-labelledby="payment-title">
      <header className="pos-order__header">
        <Button variant="ghost" startIcon={<Icon name="close" />} onClick={onBack}>
          {t('billing.back')}
        </Button>
        <h2 id="payment-title" className="pos-floor__heading">
          {data.status === 'ready'
            ? t('payment.title', { number: data.value.invoiceNumber })
            : t('billing.pay')}
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
        <PaymentForm
          view={data.value}
          onRecorded={(settled) => {
            if (settled) onDone();
            else reload();
          }}
          onOpenShift={onOpenShift}
        />
      ) : null}
    </section>
  );
}

function PaymentForm({
  view,
  onRecorded,
  onOpenShift,
}: {
  view: InvoicePaymentsView;
  onRecorded: (settled: boolean) => void;
  onOpenShift: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const [planned, setPlanned] = useState<PlannedPayment[]>([]);
  const left = stillToPay(view.remaining, planned);
  const [mode, setMode] = useState<(typeof MODES)[number]>('CASH');
  const [amount, setAmount] = useState(inputFromPaise(left));
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [invalid, setInvalid] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [needShift, setNeedShift] = useState(false);
  const [busy, setBusy] = useState(false);
  // One key per set of payments: sending the same set again is recognised (ORD-013 style).
  const [key, setKey] = useState(newKey);

  const entered = paiseFromInput(amount);
  const cashGiven = mode === 'CASH' ? (paiseFromInput(tendered) ?? null) : null;

  const add = (): PlannedPayment[] | undefined => {
    if (entered === undefined || entered > left) {
      setInvalid(t('payment.invalidAmount'));
      return undefined;
    }
    if (cashGiven !== null && cashGiven < entered) {
      setInvalid(t('payment.tenderedTooLow'));
      return undefined;
    }
    setInvalid(undefined);
    const next = [
      ...planned,
      {
        key: newKey(),
        mode,
        amount: entered,
        tendered: cashGiven,
        reference: mode === 'CASH' || reference.trim() === '' ? null : reference.trim(),
        otherModeName: mode === 'OTHER' ? t('payment.modes.OTHER') : null,
      },
    ];
    setPlanned(next);
    setKey(newKey());
    setAmount(inputFromPaise(stillToPay(view.remaining, next)));
    setTendered('');
    setReference('');
    return next;
  };

  const record = async (payments: readonly PlannedPayment[]) => {
    setBusy(true);
    setError(undefined);
    setNeedShift(false);
    try {
      const result = await controller.api.recordPayments({
        params: { id: view.invoiceId },
        body: {
          idempotencyKey: key,
          payments: payments.map((payment) => ({
            mode: payment.mode,
            amount: payment.amount,
            tendered: payment.tendered,
            reference: payment.reference,
            otherModeName: payment.otherModeName,
          })),
        },
      });
      const settled = result.remaining === 0;
      toast.show({
        title: settled
          ? t('payment.settled', { number: result.invoiceNumber })
          : t('payment.recorded', { amount: formatRupees(result.remaining) }),
        tone: 'success',
      });
      setPlanned([]);
      setKey(newKey());
      onRecorded(settled);
    } catch (failure) {
      // The key is kept: sending again cannot record the payments twice.
      const message = messageOf(failure, t);
      setError(t('payment.notRecorded', { message }));
      setNeedShift(failure instanceof ApiRequestError && failure.code === 'NO_OPEN_SHIFT');
    } finally {
      setBusy(false);
    }
  };

  // With nothing lined up yet, "Record payment" records what is entered in the form.
  const submit = () => {
    const payments = planned.length > 0 && entered === undefined ? planned : add();
    if (payments !== undefined && payments.length > 0) void record(payments);
  };

  return (
    <div className="bill">
      <Card title={t('payment.due')} headingLevel={3}>
        <dl className="bill__totals">
          <dt>{t('billing.total')}</dt>
          <dd>
            <Money paise={view.grandTotal} />
          </dd>
          <dt>{t('payment.paid')}</dt>
          <dd>
            <Money paise={view.paid} />
          </dd>
          <dt className="bill__grand">{t('payment.remaining')}</dt>
          <dd className="bill__grand">
            <Money paise={left} size="lg" strong />
          </dd>
        </dl>
        {planned.length === 0 ? null : (
          <>
            <h4>{t('payment.planned')}</h4>
            <ul className="bill__discounts">
              {planned.map((payment) => (
                <li key={payment.key} className="bill__discount">
                  <span>
                    {t(`payment.modes.${payment.mode}`)} · <Money paise={payment.amount} />
                    {payment.tendered === null ? null : (
                      <>
                        {' '}
                        · {t('payment.change')}{' '}
                        <Money paise={changeFor(payment.amount, payment.tendered)} />
                      </>
                    )}
                  </span>
                  <IconButton
                    label={t('payment.remove', { mode: t(`payment.modes.${payment.mode}`) })}
                    icon={<Icon name="close" />}
                    disabled={busy}
                    onClick={() => {
                      const next = planned.filter((entry) => entry.key !== payment.key);
                      setPlanned(next);
                      setKey(newKey());
                      setAmount(inputFromPaise(stillToPay(view.remaining, next)));
                    }}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
      <form
        className="bill__panel console-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
        {needShift ? (
          <Button variant="secondary" onClick={onOpenShift}>
            {t('payment.openShift')}
          </Button>
        ) : null}
        <Select
          label={t('payment.mode')}
          value={mode}
          options={MODES.map((value) => ({ value, label: t(`payment.modes.${value}`) }))}
          onChange={(event) => {
            setMode(MODES.find((value) => value === event.target.value) ?? 'CASH');
          }}
        />
        <TextField
          label={t('payment.amount')}
          inputMode="decimal"
          value={amount}
          error={invalid}
          onChange={(event) => {
            setAmount(event.target.value);
          }}
        />
        {mode === 'CASH' ? (
          <>
            <TextField
              label={t('payment.tendered')}
              inputMode="decimal"
              value={tendered}
              onChange={(event) => {
                setTendered(event.target.value);
              }}
            />
            {entered !== undefined && cashGiven !== null && cashGiven >= entered ? (
              <p className="bill__grand" role="status">
                {t('payment.change')}: <Money paise={changeFor(entered, cashGiven)} strong />
              </p>
            ) : null}
          </>
        ) : (
          <TextField
            label={t('payment.reference')}
            value={reference}
            maxLength={40}
            onChange={(event) => {
              setReference(event.target.value);
            }}
          />
        )}
        <div className="bill__actions">
          <Button
            variant="secondary"
            disabled={busy || left === 0}
            onClick={() => {
              add();
            }}
          >
            {t('payment.add')}
          </Button>
          <Button type="submit" size="lg" loading={busy}>
            {t('payment.record')}
          </Button>
        </div>
      </form>
    </div>
  );
}
