import type { DigitalBillEntry } from '@rp/contracts';
import { displayDateTime } from '@rp/domain';
import { Button, useToast } from '@rp/ui-web';
import { useEffect, useState } from 'react';
import { useConsole } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useLive } from '../app/use-live.js';

/** While a bill waits to go, look again this often. */
const POLL_MS = 5_000;
const never = () => false;

type Translate = ReturnType<typeof useT>;

/** What happened to the latest digital bill, in a line. */
export function digitalBillText(entry: DigitalBillEntry, t: Translate): string {
  const channel = t(`billing.digitalBill.channel.${entry.channel}`);
  switch (entry.status) {
    case 'SENT':
      return t('billing.digitalBill.sent', {
        channel,
        phone: entry.phone,
        time: entry.sentAt === null ? '' : displayDateTime(new Date(entry.sentAt)).time,
      });
    case 'QUEUED':
      return entry.lastError === null
        ? t('billing.digitalBill.queued', { phone: entry.phone })
        : t('billing.digitalBill.retrying', { phone: entry.phone, error: entry.lastError });
    case 'FAILED':
      return t('billing.digitalBill.failed', {
        phone: entry.phone,
        error: entry.lastError ?? '',
      });
  }
}

/**
 * An invoice's digital bill on the POS (BILL-012, P7-09b): whether it went to the diner on
 * WhatsApp (or SMS), and "Send again" when the diner gave a mobile number with consent. Nothing
 * while the restaurant has digital bills off.
 */
export function DigitalBillLine({
  invoiceId,
  invoiceNumber,
}: {
  invoiceId: string;
  invoiceNumber: string;
}) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { data, reload } = useLive(
    () => controller.api.listInvoiceDigitalBills({ params: { id: invoiceId } }),
    never,
  );
  const [busy, setBusy] = useState(false);
  const waiting = data.status === 'ready' && data.value.bills[0]?.status === 'QUEUED';
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(reload, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [waiting, reload]);

  if (data.status !== 'ready' || data.value.channel === 'OFF') return null;
  const { channel, phone, bills } = data.value;
  const latest = bills[0];
  if (latest === undefined && phone === null) return null;
  const channelName = t(`billing.digitalBill.channel.${channel}`);
  return (
    <p className="bill__digital">
      <span>
        {latest === undefined
          ? t('billing.digitalBill.notYet', { phone: phone ?? '' })
          : digitalBillText(latest, t)}
      </span>
      {phone === null ? null : (
        <Button
          variant="ghost"
          loading={busy}
          disabled={busy || waiting}
          aria-label={t('billing.digitalBill.sendFor', {
            number: invoiceNumber,
            channel: channelName,
          })}
          onClick={() => {
            setBusy(true);
            controller.api.sendInvoiceDigitalBill({ params: { id: invoiceId } }).then(
              () => {
                setBusy(false);
                toast.show({
                  title: t('billing.digitalBill.queuedToast', { phone, channel: channelName }),
                  tone: 'success',
                });
                reload();
              },
              (failure: unknown) => {
                setBusy(false);
                toast.show({ title: messageOf(failure, t), tone: 'danger' });
              },
            );
          }}
        >
          {latest === undefined
            ? t('billing.digitalBill.send', { channel: channelName })
            : t('billing.digitalBill.sendAgain')}
        </Button>
      )}
    </p>
  );
}
