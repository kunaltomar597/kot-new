import type { PendingApprovalsResponse } from '@rp/contracts';
import { formatRupees } from '@rp/domain';
import {
  affectsApprovals,
  alertAge,
  anythingLeft,
  approvalChanges,
  approvalTotal,
  waitingLines,
} from '@rp/ordering';
import { Button, ChoiceGroup, Dialog, QuantityStepper, TextField, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { useConsole } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useLive } from '../app/use-live.js';
import { useNow } from '../app/use-now.js';

type Entry = PendingApprovalsResponse['orders'][number];
type Open =
  | { readonly kind: 'change'; readonly entry: Entry }
  | { readonly kind: 'reject'; readonly entry: Entry };

const AGREED = 'agreed';

/**
 * Diners' orders waiting for approval at the POS (ORD-004, WTR-004): the cashier or a manager
 * approves one in one press, changes quantities or removes lines with the diner's agreement, or
 * rejects it with the reason the diner sees. Shown above the floor only while something waits.
 */
export function Approvals() {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const now = useNow(30_000);
  const { data, reload } = useLive(
    async () => (await controller.api.listPendingApprovals()).orders,
    affectsApprovals,
  );
  const [open, setOpen] = useState<Open | undefined>();
  const [busy, setBusy] = useState<string | undefined>();

  if (data.status !== 'ready' || data.value.length === 0) return null;
  const titleOf = (entry: Entry) =>
    entry.tableLabel === null
      ? t('approvals.orderTakeaway', { number: entry.order.orderNumber })
      : t('approvals.order', { table: entry.tableLabel, number: entry.order.orderNumber });
  const approve = (entry: Entry, changes: { orderItemId: string; quantity: number }[]) => {
    setBusy(entry.order.id);
    return controller.api
      .approveOrder({
        params: { orderId: entry.order.id },
        body: { changes, dinerAgreed: changes.length > 0 },
      })
      .then(
        () => {
          toast.show({
            title: t('approvals.approved', { number: entry.order.orderNumber }),
            tone: 'success',
          });
          setOpen(undefined);
        },
        (failure: unknown) => {
          toast.show({
            title: t('approvals.failed', { message: messageOf(failure, t) }),
            tone: 'danger',
          });
        },
      )
      .finally(() => {
        setBusy(undefined);
        reload();
      });
  };

  return (
    <section className="approvals" aria-labelledby="approvals-heading">
      <h2 id="approvals-heading" className="pos-floor__heading">
        {t('approvals.title', { count: data.value.length })}
      </h2>
      <ul className="approvals__list">
        {data.value.map((entry) => {
          const lines = waitingLines(entry.order);
          const title = titleOf(entry);
          return (
            <li key={entry.order.id} className="approvals__order">
              <p className="approvals__title">{title}</p>
              <p className="approvals__facts">
                {t('approvals.waited', {
                  age: alertAge(entry.order.createdAt, now, t),
                  total: formatRupees(approvalTotal(lines)),
                })}
              </p>
              <ul className="approvals__lines">
                {lines.map((line) => (
                  <li key={line.id}>
                    {t('approvals.line', { quantity: line.quantity, name: line.name })}
                    {line.details === '' && line.instructions === null ? null : (
                      <span className="approvals__details">
                        {[line.details, line.instructions]
                          .filter((part) => part !== '' && part !== null)
                          .join(' · ')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <div className="bill__actions">
                <Button
                  loading={busy === entry.order.id}
                  aria-label={t('approvals.approveOf', { title })}
                  onClick={() => {
                    void approve(entry, []);
                  }}
                >
                  {t('approvals.approve')}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy !== undefined}
                  aria-label={t('approvals.changeOf', { title })}
                  onClick={() => {
                    setOpen({ kind: 'change', entry });
                  }}
                >
                  {t('approvals.change')}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy !== undefined}
                  aria-label={t('approvals.rejectOf', { title })}
                  onClick={() => {
                    setOpen({ kind: 'reject', entry });
                  }}
                >
                  {t('approvals.reject')}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      {open?.kind === 'change' ? (
        <ChangeDialog
          title={titleOf(open.entry)}
          entry={open.entry}
          busy={busy === open.entry.order.id}
          onClose={() => {
            setOpen(undefined);
          }}
          onApprove={(changes) => approve(open.entry, changes)}
        />
      ) : null}
      {open?.kind === 'reject' ? (
        <RejectDialog
          title={titleOf(open.entry)}
          onClose={() => {
            setOpen(undefined);
          }}
          onReject={(reason) =>
            controller.api
              .rejectOrder({ params: { orderId: open.entry.order.id }, body: { reason } })
              .then(() => {
                toast.show({
                  title: t('approvals.rejected', { number: open.entry.order.orderNumber }),
                  tone: 'success',
                });
                setOpen(undefined);
                reload();
              })
          }
        />
      ) : null}
    </section>
  );
}

function ChangeDialog({
  title,
  entry,
  busy,
  onClose,
  onApprove,
}: {
  title: string;
  entry: Entry;
  busy: boolean;
  onClose: () => void;
  onApprove: (changes: { orderItemId: string; quantity: number }[]) => Promise<void>;
}) {
  const t = useT();
  const lines = waitingLines(entry.order);
  const [quantities, setQuantities] = useState<ReadonlyMap<string, number>>(new Map());
  const [agreed, setAgreed] = useState(false);
  const changes = approvalChanges(lines, quantities);
  const left = anythingLeft(lines, quantities);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('approvals.changeOf', { title })}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t('approvals.keepAsOrdered')}
          </Button>
          <Button
            loading={busy}
            disabled={!left || (changes.length > 0 && !agreed)}
            onClick={() => {
              void onApprove(changes);
            }}
          >
            {t('approvals.approveChanges')}
          </Button>
        </>
      }
    >
      <div className="console-form">
        {lines.map((line) => (
          <div key={line.id} className="approvals__change">
            <span>{line.name}</span>
            <QuantityStepper
              value={quantities.get(line.id) ?? line.quantity}
              min={0}
              max={99}
              label={t('approvals.quantityOf', { name: line.name })}
              decreaseLabel={t('pos.item.fewer')}
              increaseLabel={t('pos.item.more')}
              onChange={(value) => {
                setQuantities(new Map([...quantities, [line.id, value]]));
              }}
            />
          </div>
        ))}
        <p className="approvals__facts">{formatRupees(approvalTotal(lines, quantities))}</p>
        {left ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {t('approvals.nothingLeft')}
          </p>
        )}
        <ChoiceGroup
          legend={t('approvals.agreement')}
          mode="multiple"
          options={[{ id: AGREED, label: t('approvals.dinerAgreed') }]}
          value={agreed ? [AGREED] : []}
          onChange={(value) => {
            setAgreed(value.includes(AGREED));
          }}
        />
      </div>
    </Dialog>
  );
}

function RejectDialog({
  title,
  onClose,
  onReject,
}: {
  title: string;
  onClose: () => void;
  onReject: (reason: string) => Promise<void>;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('approvals.rejectOf', { title })}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t('approvals.cancel')}
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={reason.trim().length < 3}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              onReject(reason.trim()).then(
                () => {
                  setBusy(false);
                },
                (failure: unknown) => {
                  setBusy(false);
                  setError(t('approvals.failed', { message: messageOf(failure, t) }));
                },
              );
            }}
          >
            {t('approvals.rejectConfirm')}
          </Button>
        </>
      }
    >
      <TextField
        label={t('approvals.reason')}
        value={reason}
        maxLength={200}
        error={error}
        onChange={(event) => {
          setReason(event.target.value);
        }}
      />
    </Dialog>
  );
}
