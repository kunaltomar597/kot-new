import type { BillCustomerRequest, BillView } from '@rp/contracts';
import { Button, Dialog, TextField } from '@rp/ui-web';
import { useId, useState } from 'react';
import { useT } from '../app/i18n.js';

/**
 * Optional customer details (BILL-011): a phone number is kept only with the customer's consent,
 * and a GSTIN makes it a B2B invoice.
 */
export function CustomerDialog({
  bill,
  onSave,
  onClose,
  busy,
  error,
}: {
  bill: BillView;
  onSave: (customer: BillCustomerRequest) => void;
  onClose: () => void;
  busy: boolean;
  error: string | undefined;
}) {
  const t = useT();
  const formId = useId();
  const [name, setName] = useState(bill.customer.name ?? '');
  const [phone, setPhone] = useState(bill.customer.phone ?? '');
  const [consent, setConsent] = useState(bill.customer.phoneConsent);
  const [gstin, setGstin] = useState(bill.customer.gstin ?? '');
  const blank = (text: string) => (text.trim() === '' ? null : text.trim());

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={t('billing.customer.edit')}
      footer={
        <Button type="submit" form={formId} loading={busy}>
          {t('billing.customer.save')}
        </Button>
      }
    >
      <form
        id={formId}
        className="console-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            name: blank(name),
            phone: blank(phone),
            phoneConsent: blank(phone) !== null && consent,
            gstin: blank(gstin)?.toUpperCase() ?? null,
          });
        }}
      >
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
        <TextField
          label={t('billing.customer.name')}
          value={name}
          maxLength={60}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <TextField
          label={t('billing.customer.phone')}
          type="tel"
          value={phone}
          maxLength={16}
          onChange={(event) => {
            setPhone(event.target.value);
          }}
        />
        <label className="console-check">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => {
              setConsent(event.target.checked);
            }}
          />
          {t('billing.customer.consent')}
        </label>
        <TextField
          label={t('billing.customer.gstin')}
          value={gstin}
          maxLength={15}
          onChange={(event) => {
            setGstin(event.target.value);
          }}
        />
      </form>
    </Dialog>
  );
}
