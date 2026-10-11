import {
  BILLING_CYCLES,
  type BillingCycle,
  type PlanView,
  type SubscriptionView,
} from '@rp/contracts/control-plane';
import { calendarDateOf } from '@rp/domain';
import { Button, Dialog, Select, TextField, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { Link } from 'react-router';
import { day, rupees, when } from '../app/format.js';
import { useT } from '../app/i18n.js';
import { isNotFound, messageOf } from '../app/messages.js';
import { useApi, useMay } from '../app/services.js';
import { useLoad } from '../app/use-load.js';
import { LoadView } from '../components/LoadView.js';

/** The cycles a plan is offered on: those with a price. */
export function cyclesOf(plan: PlanView | undefined): BillingCycle[] {
  if (plan === undefined) return [];
  return BILLING_CYCLES.filter((cycle) => plan.prices[cycle] !== null);
}

function SubscribeDialog({
  tenantId,
  current,
  onClose,
  onSaved,
}: {
  tenantId: string;
  current: SubscriptionView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const api = useApi();
  const { data, reload } = useLoad((signal) => api.listPlans({ signal }), 'plans');
  const [planId, setPlanId] = useState(current?.planId ?? '');
  const [cycle, setCycle] = useState<BillingCycle | ''>(current?.cycle ?? '');
  const [startsOn, setStartsOn] = useState(() => calendarDateOf(new Date()));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const plans =
    data.status === 'ready' ? data.value.plans.filter((plan) => plan.archivedAt === null) : [];
  const plan = plans.find((candidate) => candidate.id === planId);
  const cycles = cyclesOf(plan);
  const chosenCycle = cycle !== '' && cycles.includes(cycle) ? cycle : undefined;
  const ready =
    plan !== undefined && chosenCycle !== undefined && startsOn !== '' && reason.trim().length >= 3;

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={
        current === null
          ? t('vendorApp.subscription.addTitle')
          : t('vendorApp.subscription.changeTitle')
      }
      description={t('vendorApp.subscription.intro')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('vendorApp.actions.cancel')}
          </Button>
          <Button
            loading={busy}
            disabled={busy || !ready}
            onClick={() => {
              if (plan === undefined || chosenCycle === undefined) return;
              setBusy(true);
              setError(undefined);
              api
                .setSubscription({
                  params: { id: tenantId },
                  body: { planId: plan.id, cycle: chosenCycle, startsOn, reason: reason.trim() },
                })
                .then(onSaved, (failure: unknown) => {
                  setBusy(false);
                  setError(messageOf(failure, t));
                });
            }}
          >
            {t('vendorApp.actions.save')}
          </Button>
        </>
      }
    >
      <LoadView data={data} reload={reload} failed={t('vendorApp.plans.loadFailed')}>
        {() => (
          <div className="cp-form">
            <Select
              label={t('vendorApp.subscription.plan')}
              placeholder={t('vendorApp.subscription.choosePlan')}
              value={planId}
              options={plans.map((option) => ({ value: option.id, label: option.name }))}
              onChange={(event) => {
                setPlanId(event.target.value);
              }}
            />
            <Select
              label={t('vendorApp.subscription.cycle')}
              placeholder={t('vendorApp.subscription.chooseCycle')}
              value={chosenCycle ?? ''}
              disabled={plan === undefined}
              options={cycles.map((option) => ({
                value: option,
                label: t('vendorApp.subscription.cycleWithPrice', {
                  cycle: t(`vendorApp.cycle.${option}`),
                  price: rupees(plan?.prices[option] ?? 0),
                }),
              }))}
              onChange={(event) => {
                setCycle(event.target.value as BillingCycle);
              }}
            />
            <TextField
              label={t('vendorApp.subscription.startsOn')}
              hint={t('vendorApp.subscription.startsOnHint')}
              type="date"
              value={startsOn}
              onChange={(event) => {
                setStartsOn(event.target.value);
              }}
            />
            <TextField
              label={t('vendorApp.reason.label')}
              hint={t('vendorApp.reason.hint')}
              value={reason}
              maxLength={200}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </div>
        )}
      </LoadView>
      {error === undefined ? null : (
        <p role="alert" className="cp-notice cp-notice--danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** A restaurant's plan and billing cycle (VCP-003); Finance puts it on a plan or changes it. */
export function SubscriptionPanel({ tenantId }: { tenantId: string }) {
  const t = useT();
  const api = useApi();
  const may = useMay();
  const toast = useToast();
  const { data, reload } = useLoad(async (signal) => {
    try {
      return await api.getSubscription({ params: { id: tenantId }, signal });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }, `subscription:${tenantId}`);
  const [open, setOpen] = useState(false);

  return (
    <div className="cp-panel">
      <LoadView data={data} reload={reload} failed={t('vendorApp.subscription.loadFailed')}>
        {(subscription) => (
          <>
            {subscription === null ? (
              <p className="cp-hint">{t('vendorApp.subscription.none')}</p>
            ) : (
              <dl className="cp-facts">
                <div className="cp-facts__row">
                  <dt>{t('vendorApp.subscription.plan')}</dt>
                  <dd>{subscription.planName}</dd>
                </div>
                <div className="cp-facts__row">
                  <dt>{t('vendorApp.subscription.cycle')}</dt>
                  <dd>
                    {t('vendorApp.subscription.cycleWithPrice', {
                      cycle: t(`vendorApp.cycle.${subscription.cycle}`),
                      price: rupees(subscription.price),
                    })}
                  </dd>
                </div>
                <div className="cp-facts__row">
                  <dt>{t('vendorApp.subscription.startedOn')}</dt>
                  <dd>{day(subscription.startedOn)}</dd>
                </div>
                <div className="cp-facts__row">
                  <dt>{t('vendorApp.subscription.nextInvoice')}</dt>
                  <dd>{day(subscription.nextInvoiceOn)}</dd>
                </div>
                {subscription.cancelledAt === null ? null : (
                  <div className="cp-facts__row">
                    <dt>{t('vendorApp.subscription.cancelledAt')}</dt>
                    <dd>{when(subscription.cancelledAt)}</dd>
                  </div>
                )}
              </dl>
            )}
            <div className="cp-actions">
              {may('BILLING_MANAGE') ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setOpen(true);
                  }}
                >
                  {subscription === null
                    ? t('vendorApp.subscription.add')
                    : t('vendorApp.subscription.change')}
                </Button>
              ) : null}
              <Link className="cp-link" to={`/invoices?tenant=${tenantId}`}>
                {t('vendorApp.subscription.invoices')}
              </Link>
            </div>
            {open ? (
              <SubscribeDialog
                tenantId={tenantId}
                current={subscription}
                onClose={() => {
                  setOpen(false);
                }}
                onSaved={() => {
                  setOpen(false);
                  toast.show({ title: t('vendorApp.subscription.saved'), tone: 'success' });
                  reload();
                }}
              />
            ) : null}
          </>
        )}
      </LoadView>
    </div>
  );
}
