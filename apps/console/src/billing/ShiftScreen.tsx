import type { ShiftView } from '@rp/contracts';
import { formatRupees } from '@rp/domain';
import {
  Button,
  Card,
  ErrorState,
  Icon,
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
import { paiseFromInput } from './money-input.js';

const never = () => false;

/**
 * The cashier's shift (BILL-013, BILL-008): open it with the float counted into the drawer, record
 * cash taken in or out with a reason, and close it with the counted cash; the server says what the
 * drawer should hold and the difference.
 */
export function ShiftScreen({ onBack }: { onBack: () => void }) {
  const t = useT();
  const controller = useConsole();
  const { data, reload } = useLive(() => controller.api.getCurrentShift(), never);

  return (
    <section className="pos-order" aria-labelledby="shift-title">
      <header className="pos-order__header">
        <Button variant="ghost" startIcon={<Icon name="close" />} onClick={onBack}>
          {t('pos.backToTables')}
        </Button>
        <h2 id="shift-title" className="pos-floor__heading">
          {t('shift.title')}
        </h2>
      </header>
      {data.status === 'loading' ? <LoadingState title={t('states.loading')} /> : null}
      {data.status === 'error' ? (
        <ErrorState
          title={messageOf(data.error, t)}
          action={<Button onClick={reload}>{t('states.retry')}</Button>}
        />
      ) : null}
      {data.status === 'ready' && data.value.shift === null ? (
        <OpenShift onOpened={reload} />
      ) : null}
      {data.status === 'ready' && data.value.shift !== null ? (
        <OpenShiftView shift={data.value.shift} onChanged={reload} />
      ) : null}
    </section>
  );
}

function OpenShift({ onOpened }: { onOpened: () => void }) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const [float, setFloat] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const open = async () => {
    const openingFloat = float.trim() === '0' ? 0 : paiseFromInput(float);
    if (openingFloat === undefined) {
      setError(t('shift.invalidAmount'));
      return;
    }
    setBusy(true);
    try {
      await controller.api.openShift({ body: { openingFloat } });
      toast.show({ title: t('shift.opened'), tone: 'success' });
      onOpened();
    } catch (failure) {
      setError(messageOf(failure, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('shift.none')} headingLevel={3}>
      <form
        className="console-form"
        onSubmit={(event) => {
          event.preventDefault();
          void open();
        }}
      >
        <TextField
          label={t('shift.openingFloat')}
          inputMode="decimal"
          value={float}
          error={error}
          onChange={(event) => {
            setFloat(event.target.value);
          }}
        />
        <Button type="submit" loading={busy}>
          {t('shift.open')}
        </Button>
      </form>
    </Card>
  );
}

function OpenShiftView({ shift, onChanged }: { shift: ShiftView; onChanged: () => void }) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const [direction, setDirection] = useState<'IN' | 'OUT'>('OUT');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [counted, setCounted] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const act = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      toast.show({ title: done, tone: 'success' });
      onChanged();
    } catch (failure) {
      setError(messageOf(failure, t));
    } finally {
      setBusy(false);
    }
  };

  const move = () => {
    const paise = paiseFromInput(amount);
    if (paise === undefined) {
      setError(t('shift.invalidAmount'));
      return;
    }
    void act(async () => {
      await controller.api.recordCashMovement({
        params: { id: shift.id },
        body: { direction, amount: paise, reason: reason.trim() },
      });
      setAmount('');
      setReason('');
    }, t('shift.recorded'));
  };

  const close = () => {
    const paise = counted.trim() === '0' ? 0 : paiseFromInput(counted);
    if (paise === undefined) {
      setError(t('shift.invalidAmount'));
      return;
    }
    setBusy(true);
    setError(undefined);
    controller.api
      .closeShift({ params: { id: shift.id }, body: { countedCash: paise } })
      .then(
        (closed) => {
          toast.show({
            title: t('shift.closed', { variance: formatRupees(closed.variance ?? 0) }),
            tone: (closed.variance ?? 0) === 0 ? 'success' : 'warning',
          });
          onChanged();
        },
        (failure: unknown) => {
          setError(messageOf(failure, t));
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className="bill">
      <Card
        title={t('shift.status', { time: new Date(shift.openedAt).toLocaleTimeString() })}
        headingLevel={3}
      >
        <dl className="bill__totals">
          <dt>{t('shift.openingFloat')}</dt>
          <dd>
            <Money paise={shift.openingFloat} />
          </dd>
          <dt>{t('shift.cashPayments')}</dt>
          <dd>
            <Money paise={shift.cashPayments} />
          </dd>
          <dt>{t('shift.cashIn')}</dt>
          <dd>
            <Money paise={shift.cashIn} />
          </dd>
          <dt>{t('shift.cashOut')}</dt>
          <dd>
            <Money paise={shift.cashOut} />
          </dd>
          <dt className="bill__grand">{t('shift.expected')}</dt>
          <dd className="bill__grand">
            <Money paise={shift.expectedCash} strong signTone />
          </dd>
        </dl>
      </Card>
      <div className="bill__panel">
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
        <Card title={t('shift.movement')} headingLevel={3}>
          <form
            className="console-form"
            onSubmit={(event) => {
              event.preventDefault();
              move();
            }}
          >
            <Select
              label={t('shift.direction')}
              value={direction}
              options={[
                { value: 'OUT', label: t('shift.out') },
                { value: 'IN', label: t('shift.in') },
              ]}
              onChange={(event) => {
                setDirection(event.target.value === 'IN' ? 'IN' : 'OUT');
              }}
            />
            <TextField
              label={t('shift.movementAmount')}
              inputMode="decimal"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
            />
            <TextField
              label={t('shift.movementReason')}
              value={reason}
              maxLength={200}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            <Button type="submit" variant="secondary" loading={busy}>
              {t('shift.record')}
            </Button>
          </form>
        </Card>
        <Card title={t('shift.close')} headingLevel={3}>
          <form
            className="console-form"
            onSubmit={(event) => {
              event.preventDefault();
              close();
            }}
          >
            <TextField
              label={t('shift.counted')}
              inputMode="decimal"
              value={counted}
              onChange={(event) => {
                setCounted(event.target.value);
              }}
            />
            <Button type="submit" variant="danger" loading={busy}>
              {t('shift.close')}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
