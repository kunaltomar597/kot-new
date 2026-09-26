import type { BillView, DiscountRequest } from '@rp/contracts';
import { parseRupees } from '@rp/domain';
import { Button, Dialog, Select, TextField } from '@rp/ui-web';
import { useId, useState } from 'react';
import { useT } from '../app/i18n.js';
import { paiseFromInput } from './money-input.js';

/**
 * A discount on the whole bill or one line, as a percentage or an amount off, with the mandatory
 * reason (BILL-005). The server decides whether a manager must approve it.
 */
export function DiscountDialog({
  bill,
  onApply,
  onClose,
  busy,
  error,
}: {
  bill: BillView;
  onApply: (discount: DiscountRequest) => void;
  onClose: () => void;
  busy: boolean;
  error: string | undefined;
}) {
  const t = useT();
  const formId = useId();
  const [scope, setScope] = useState('');
  const [kind, setKind] = useState<'PERCENT' | 'FLAT'>('PERCENT');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState<string | undefined>();

  const apply = () => {
    let rateBp: number | null = null;
    let amount: number | null = null;
    if (kind === 'PERCENT') {
      // "12.5" % is 1,250 basis points: the same arithmetic as rupees to paise.
      try {
        rateBp = parseRupees(value);
      } catch {
        rateBp = null;
      }
      if (rateBp === null || rateBp < 1 || rateBp > 10_000) {
        setInvalid(t('billing.discount.invalid'));
        return;
      }
    } else {
      amount = paiseFromInput(value) ?? null;
      if (amount === null) {
        setInvalid(t('billing.discount.invalid'));
        return;
      }
    }
    setInvalid(undefined);
    onApply({
      orderItemId: scope === '' ? null : scope,
      kind,
      rateBp,
      amount,
      reason: reason.trim(),
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={t('billing.discount.title')}
      footer={
        <Button type="submit" form={formId} loading={busy} disabled={reason.trim().length < 3}>
          {t('billing.discount.apply')}
        </Button>
      }
    >
      <form
        id={formId}
        className="console-form"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <Select
          label={t('billing.discount.scope')}
          value={scope}
          options={[
            { value: '', label: t('billing.discount.wholeBill') },
            ...bill.lines.map((line) => ({ value: line.orderItemId, label: line.description })),
          ]}
          onChange={(event) => {
            setScope(event.target.value);
          }}
        />
        <Select
          label={t('billing.discount.kind')}
          value={kind}
          options={[
            { value: 'PERCENT', label: t('billing.discount.percent') },
            { value: 'FLAT', label: t('billing.discount.flat') },
          ]}
          onChange={(event) => {
            setKind(event.target.value === 'FLAT' ? 'FLAT' : 'PERCENT');
          }}
        />
        <TextField
          label={
            kind === 'PERCENT'
              ? t('billing.discount.percentValue')
              : t('billing.discount.amountValue')
          }
          inputMode="decimal"
          value={value}
          error={invalid}
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
        <TextField
          label={t('billing.discount.reason')}
          value={reason}
          maxLength={200}
          error={error}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </form>
    </Dialog>
  );
}
