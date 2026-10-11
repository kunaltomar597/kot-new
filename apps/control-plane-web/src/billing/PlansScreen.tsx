import {
  BILLING_CYCLES,
  LICENCE_MODULES,
  type LicenceModule,
  type PlanRequest,
  type PlanView,
} from '@rp/contracts/control-plane';
import { Badge, Button, ChoiceGroup, Dialog, Table, TextField, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { rupees } from '../app/format.js';
import { useT } from '../app/i18n.js';
import { fieldErrors, messageOf } from '../app/messages.js';
import { useApi, useMay } from '../app/services.js';
import { useLoad } from '../app/use-load.js';
import { LoadView } from '../components/LoadView.js';
import { Page } from '../components/Page.js';
import { ReasonDialog } from '../components/ReasonDialog.js';
import { DEVICE_KINDS } from '../tenants/licence-change.js';
import { EMPTY_PLAN, type PlanDraft, planDraftOf, planRequestOf } from './plan-form.js';

function PlanDialog({
  plan,
  onClose,
  onSave,
}: {
  plan: PlanView | undefined;
  onClose: () => void;
  onSave: (request: PlanRequest) => Promise<void>;
}) {
  const t = useT();
  const [draft, setDraft] = useState<PlanDraft>(() =>
    plan === undefined ? EMPTY_PLAN : planDraftOf(plan),
  );
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={plan === undefined ? t('vendorApp.plans.addTitle') : t('vendorApp.plans.editTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('vendorApp.actions.cancel')}
          </Button>
          <Button
            loading={busy}
            disabled={busy}
            onClick={() => {
              const parsed = planRequestOf(draft);
              if (!parsed.success) {
                setErrors(fieldErrors(parsed.error));
                return;
              }
              setErrors({});
              setBusy(true);
              setError(undefined);
              onSave(parsed.data).catch((failure: unknown) => {
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
      <div className="cp-form cp-form--grid">
        <TextField
          label={t('vendorApp.plans.code')}
          hint={t('vendorApp.plans.codeHint')}
          value={draft.code}
          maxLength={24}
          error={errors.code}
          onChange={(event) => {
            setDraft({ ...draft, code: event.target.value });
          }}
        />
        <TextField
          label={t('vendorApp.plans.name')}
          value={draft.name}
          maxLength={40}
          error={errors.name}
          onChange={(event) => {
            setDraft({ ...draft, name: event.target.value });
          }}
        />
        {BILLING_CYCLES.map((cycle) => (
          <TextField
            key={cycle}
            label={t(`vendorApp.plans.price.${cycle}`)}
            hint={t('vendorApp.plans.priceHint')}
            inputMode="decimal"
            value={draft.prices[cycle]}
            error={errors[`prices.${cycle}`] ?? (cycle === 'MONTHLY' ? errors.prices : undefined)}
            onChange={(event) => {
              setDraft({ ...draft, prices: { ...draft.prices, [cycle]: event.target.value } });
            }}
          />
        ))}
        {DEVICE_KINDS.map((kind) => (
          <TextField
            key={kind}
            label={t(`vendorApp.licence.device.${kind}`)}
            inputMode="numeric"
            value={draft.deviceLimits[kind]}
            error={errors[`deviceLimits.${kind}`]}
            onChange={(event) => {
              setDraft({
                ...draft,
                deviceLimits: { ...draft.deviceLimits, [kind]: event.target.value },
              });
            }}
          />
        ))}
      </div>
      <ChoiceGroup
        legend={t('vendorApp.licence.modules')}
        mode="multiple"
        options={LICENCE_MODULES.map((module) => ({
          id: module,
          label: t(`vendorApp.licence.module.${module}`),
        }))}
        value={draft.modules}
        error={errors.modules}
        onChange={(modules) => {
          setDraft({ ...draft, modules: modules as LicenceModule[] });
        }}
      />
      {error === undefined ? null : (
        <p role="alert" className="cp-notice cp-notice--danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** The plan catalogue (VCP-003): prices per cycle, device limits and modules; Finance edits it. */
export function PlansScreen() {
  const t = useT();
  const api = useApi();
  const may = useMay();
  const toast = useToast();
  const { data, reload } = useLoad((signal) => api.listPlans({ signal }), 'plans');
  const [editing, setEditing] = useState<{ plan: PlanView | undefined } | undefined>();
  const [archiving, setArchiving] = useState<PlanView | undefined>();
  const manage = may('BILLING_MANAGE');
  const price = (value: number | null) => (value === null ? '—' : rupees(value));

  return (
    <Page
      title={t('vendorApp.plans.title')}
      intro={t('vendorApp.plans.intro')}
      actions={
        manage ? (
          <Button
            onClick={() => {
              setEditing({ plan: undefined });
            }}
          >
            {t('vendorApp.plans.add')}
          </Button>
        ) : undefined
      }
    >
      <LoadView data={data} reload={reload} failed={t('vendorApp.plans.loadFailed')}>
        {({ plans }) => (
          <Table
            caption={t('vendorApp.plans.title')}
            hideCaption
            rows={plans}
            rowKey={(plan) => plan.id}
            empty={t('vendorApp.plans.empty')}
            columns={[
              {
                key: 'name',
                header: t('vendorApp.plans.name'),
                cell: (plan) => (
                  <>
                    {plan.name} <span className="cp-hint">{plan.code}</span>{' '}
                    {plan.archivedAt === null ? null : (
                      <Badge tone="neutral">{t('vendorApp.plans.archived')}</Badge>
                    )}
                  </>
                ),
              },
              ...BILLING_CYCLES.map((cycle) => ({
                key: cycle,
                header: t(`vendorApp.plans.price.${cycle}`),
                align: 'end' as const,
                cell: (plan: PlanView) => price(plan.prices[cycle]),
              })),
              {
                key: 'devices',
                header: t('vendorApp.plans.devices'),
                cell: (plan) =>
                  t('vendorApp.plans.deviceSummary', {
                    tablets: plan.deviceLimits.TABLE_TABLET,
                    phones: plan.deviceLimits.WAITER_PHONE,
                    pagers: plan.deviceLimits.PAGER,
                    kds: plan.deviceLimits.KDS,
                  }),
              },
              {
                key: 'subscribers',
                header: t('vendorApp.plans.subscribers'),
                align: 'end',
                cell: (plan) => String(plan.subscribers),
              },
              ...(manage
                ? [
                    {
                      key: 'actions',
                      header: t('vendorApp.actions.header'),
                      cell: (plan: PlanView) =>
                        plan.archivedAt === null ? (
                          <div className="cp-actions">
                            <Button
                              variant="secondary"
                              aria-label={t('vendorApp.plans.editNamed', { name: plan.name })}
                              onClick={() => {
                                setEditing({ plan });
                              }}
                            >
                              {t('vendorApp.plans.edit')}
                            </Button>
                            <Button
                              variant="ghost"
                              aria-label={t('vendorApp.plans.archiveNamed', { name: plan.name })}
                              onClick={() => {
                                setArchiving(plan);
                              }}
                            >
                              {t('vendorApp.plans.archive')}
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
      {editing === undefined ? null : (
        <PlanDialog
          plan={editing.plan}
          onClose={() => {
            setEditing(undefined);
          }}
          onSave={async (request) => {
            if (editing.plan === undefined) await api.createPlan({ body: request });
            else await api.updatePlan({ params: { id: editing.plan.id }, body: request });
            setEditing(undefined);
            toast.show({ title: t('vendorApp.plans.saved'), tone: 'success' });
            reload();
          }}
        />
      )}
      <ReasonDialog
        open={archiving !== undefined}
        title={t('vendorApp.plans.archiveTitle', { name: archiving?.name ?? '' })}
        description={t('vendorApp.plans.archiveIntro')}
        confirmLabel={t('vendorApp.plans.archive')}
        onClose={() => {
          setArchiving(undefined);
        }}
        onConfirm={async (reason) => {
          await api.archivePlan({ params: { id: archiving?.id ?? '' }, body: { reason } });
          setArchiving(undefined);
          toast.show({ title: t('vendorApp.plans.archivedDone'), tone: 'success' });
          reload();
        }}
      />
    </Page>
  );
}
