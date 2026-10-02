import {
  LicenceChangeRequest,
  type LicenceState,
  type ReactivationCodeView,
  type VendorLicenceView,
} from '@rp/contracts/control-plane';
import { addDays, calendarDateOf } from '@rp/domain';
import { Button, Card, Dialog, Select, TextField, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { day, when, whenOrDash } from '../app/format.js';
import { useT } from '../app/i18n.js';
import { fieldErrors, messageOf } from '../app/messages.js';
import { useApi, useMay } from '../app/services.js';
import { useLoad } from '../app/use-load.js';
import { LicenceBadge } from '../components/LicenceBadge.js';
import { LoadView } from '../components/LoadView.js';
import { OneTimeSecret } from '../components/OneTimeSecret.js';
import { ReasonDialog } from '../components/ReasonDialog.js';
import {
  DEVICE_KINDS,
  type LicenceDraft,
  licenceChangeOf,
  licenceDraftOf,
  licenceTargets,
} from './licence-change.js';

/** Reactivation codes reach at most this far ahead (the Control Plane's limit, LIC-006). */
const REACTIVATION_MAX_DAYS = 60;

function ChangeDialog({
  licence,
  onClose,
  onSaved,
}: {
  licence: VendorLicenceView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const api = useApi();
  const [draft, setDraft] = useState<LicenceDraft>(() => licenceDraftOf(licence));
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const change = licenceChangeOf(licence, draft);
  const number = (key: 'validityDays' | 'graceDays', label: string, hint?: string) => (
    <TextField
      label={label}
      hint={hint}
      inputMode="numeric"
      value={draft[key]}
      error={errors[key]}
      onChange={(event) => {
        setDraft({ ...draft, [key]: event.target.value });
      }}
    />
  );
  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={t('vendorApp.licence.changeTitle')}
      description={t('vendorApp.licence.changeIntro')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('vendorApp.actions.cancel')}
          </Button>
          <Button
            loading={busy}
            disabled={busy || change === undefined || draft.reason.trim().length < 3}
            onClick={() => {
              if (change === undefined) return;
              const parsed = LicenceChangeRequest.safeParse(change);
              if (!parsed.success) {
                setErrors(fieldErrors(parsed.error));
                return;
              }
              setErrors({});
              setBusy(true);
              setError(undefined);
              api
                .changeVendorLicence({
                  params: { id: licence.installationId },
                  body: parsed.data,
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
      <div className="cp-form cp-form--grid">
        <Select
          label={t('vendorApp.licence.stateLabel')}
          value={draft.state}
          options={licenceTargets(licence.state).map((state) => ({
            value: state,
            label: t(`vendorApp.licence.state.${state}`),
          }))}
          onChange={(event) => {
            setDraft({ ...draft, state: event.target.value as LicenceState });
          }}
        />
        <TextField
          label={t('vendorApp.licence.plan')}
          value={draft.plan}
          maxLength={40}
          error={errors.plan}
          onChange={(event) => {
            setDraft({ ...draft, plan: event.target.value });
          }}
        />
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
        {number(
          'validityDays',
          t('vendorApp.licence.validityDays'),
          t('vendorApp.licence.validityHint'),
        )}
        {number('graceDays', t('vendorApp.licence.graceDays'))}
      </div>
      <TextField
        label={t('vendorApp.reason.label')}
        hint={t('vendorApp.reason.hint')}
        value={draft.reason}
        maxLength={200}
        error={errors.reason}
        onChange={(event) => {
          setDraft({ ...draft, reason: event.target.value });
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

function ReactivationDialog({
  installationId,
  onClose,
}: {
  installationId: string;
  onClose: () => void;
}) {
  const t = useT();
  const api = useApi();
  const today = calendarDateOf(new Date());
  const [until, setUntil] = useState(() => addDays(today, 7));
  const [issued, setIssued] = useState<ReactivationCodeView | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('vendorApp.licence.reactivationTitle')}
      description={issued === undefined ? t('vendorApp.licence.reactivationIntro') : undefined}
      footer={
        issued === undefined ? (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {t('vendorApp.actions.cancel')}
            </Button>
            <Button
              loading={busy}
              disabled={busy || until === ''}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                api
                  .createReactivationCode({ params: { id: installationId }, body: { until } })
                  .then(
                    (code) => {
                      setBusy(false);
                      setIssued(code);
                    },
                    (failure: unknown) => {
                      setBusy(false);
                      setError(messageOf(failure, t));
                    },
                  );
              }}
            >
              {t('vendorApp.licence.reactivationCreate')}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>{t('vendorApp.actions.done')}</Button>
        )
      }
    >
      {issued === undefined ? (
        <TextField
          label={t('vendorApp.licence.reactivationUntil')}
          type="date"
          min={today}
          max={addDays(today, REACTIVATION_MAX_DAYS)}
          value={until}
          onChange={(event) => {
            setUntil(event.target.value);
          }}
        />
      ) : (
        <OneTimeSecret
          label={t('vendorApp.licence.reactivationCode')}
          value={issued.code}
          hint={t('vendorApp.licence.reactivationHint', { until: day(issued.validUntil) })}
        />
      )}
      {error === undefined ? null : (
        <p role="alert" className="cp-notice cp-notice--danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/**
 * An installation's licence (VCP-003, LIC-001 to LIC-006): its state and why, plan, limits and
 * days, the latest licence file; Finance changes it, Support and Finance give reactivation codes,
 * Support and Onboarding let it bind a new PC. Every change carries a reason and is audited.
 */
export function LicenceCard({ installationId }: { installationId: string }) {
  const t = useT();
  const api = useApi();
  const may = useMay();
  const toast = useToast();
  const { data, reload } = useLoad(
    (signal) => api.getVendorLicence({ params: { id: installationId }, signal }),
    `licence:${installationId}`,
  );
  const [open, setOpen] = useState<'change' | 'rebind' | 'code' | undefined>();
  const close = () => {
    setOpen(undefined);
  };

  return (
    <Card title={t('vendorApp.licence.title')} headingLevel={2}>
      <LoadView data={data} reload={reload} failed={t('vendorApp.licence.loadFailed')}>
        {(licence) => (
          <>
            <p>
              <LicenceBadge state={licence.state} />
            </p>
            {licence.reason === null ? null : (
              <p>{t('vendorApp.licence.reason', { reason: licence.reason })}</p>
            )}
            <dl className="cp-facts">
              <div className="cp-facts__row">
                <dt>{t('vendorApp.licence.plan')}</dt>
                <dd>{licence.plan}</dd>
              </div>
              <div className="cp-facts__row">
                <dt>{t('vendorApp.licence.modules')}</dt>
                <dd>
                  {licence.modules.length === 0
                    ? '—'
                    : licence.modules
                        .map((module) => t(`vendorApp.licence.module.${module}`))
                        .join(', ')}
                </dd>
              </div>
              {DEVICE_KINDS.map((kind) => (
                <div key={kind} className="cp-facts__row">
                  <dt>{t(`vendorApp.licence.device.${kind}`)}</dt>
                  <dd>{String(licence.deviceLimits[kind])}</dd>
                </div>
              ))}
              <div className="cp-facts__row">
                <dt>{t('vendorApp.licence.validityDays')}</dt>
                <dd>{String(licence.validityDays)}</dd>
              </div>
              <div className="cp-facts__row">
                <dt>{t('vendorApp.licence.graceDays')}</dt>
                <dd>{String(licence.graceDays)}</dd>
              </div>
              <div className="cp-facts__row">
                <dt>{t('vendorApp.licence.graceStarted')}</dt>
                <dd>{whenOrDash(licence.graceStartedAt)}</dd>
              </div>
              <div className="cp-facts__row">
                <dt>{t('vendorApp.licence.boundAt')}</dt>
                <dd>{whenOrDash(licence.boundAt)}</dd>
              </div>
              <div className="cp-facts__row">
                <dt>{t('vendorApp.licence.latest')}</dt>
                <dd>
                  {licence.latest === null
                    ? t('vendorApp.licence.noFile')
                    : t('vendorApp.licence.file', {
                        issued: when(licence.latest.issuedAt),
                        until: when(licence.latest.validUntil),
                      })}
                </dd>
              </div>
            </dl>
            <div className="cp-actions">
              {may('LICENCES_MANAGE') && licence.state !== 'TERMINATED' ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setOpen('change');
                  }}
                >
                  {t('vendorApp.licence.change')}
                </Button>
              ) : null}
              {may('REACTIVATION_CODES') && licence.state !== 'TERMINATED' ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setOpen('code');
                  }}
                >
                  {t('vendorApp.licence.reactivation')}
                </Button>
              ) : null}
              {may('LICENCE_REBIND') && licence.boundAt !== null ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setOpen('rebind');
                  }}
                >
                  {t('vendorApp.licence.rebind')}
                </Button>
              ) : null}
            </div>
            {open === 'change' ? (
              <ChangeDialog
                licence={licence}
                onClose={close}
                onSaved={() => {
                  close();
                  toast.show({ title: t('vendorApp.licence.changed'), tone: 'success' });
                  reload();
                }}
              />
            ) : null}
            {open === 'code' ? (
              <ReactivationDialog installationId={installationId} onClose={close} />
            ) : null}
            <ReasonDialog
              open={open === 'rebind'}
              title={t('vendorApp.licence.rebindTitle')}
              description={t('vendorApp.licence.rebindIntro')}
              confirmLabel={t('vendorApp.licence.rebind')}
              onClose={close}
              onConfirm={async (reason) => {
                await api.rebindVendorLicence({ params: { id: installationId }, body: { reason } });
                close();
                toast.show({ title: t('vendorApp.licence.rebound'), tone: 'success' });
                reload();
              }}
            />
          </>
        )}
      </LoadView>
    </Card>
  );
}
