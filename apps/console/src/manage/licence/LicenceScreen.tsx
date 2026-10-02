import type { LicenceView } from '@rp/contracts';
import { displayDateTime } from '@rp/domain';
import { affectsLicence } from '@rp/ordering';
import { Badge, Button, ErrorState, LoadingState, TextField, useToast } from '@rp/ui-web';
import { type ReactNode, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { SecondFactorCancelled, useSecondFactor } from '../../owner/second-factor.js';

const TONE = {
  ACTIVE: 'success',
  PAYMENT_DUE: 'info',
  GRACE: 'warning',
  RESTRICTED: 'danger',
  TERMINATED: 'danger',
} as const;

const DEVICE_KINDS = ['TABLE_TABLET', 'PAGER', 'WAITER_PHONE', 'KDS'] as const;

/**
 * The licence as this PC knows it (LIC-008): its state and days left, why, until when, the plan,
 * modules and device limits against what is paired. The Owner can ask the vendor now (after
 * paying, LIC-006) or enter a reactivation code read out over the phone when the PC is offline.
 */
export function LicenceScreen({ owner }: { owner: boolean }) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { data, reload } = useLive(() => controller.api.getLicence(), affectsLicence);
  const { withSecondFactor, dialog } = useSecondFactor();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'check' | 'code' | undefined>();
  const [error, setError] = useState<string | undefined>();

  const act = async (kind: 'check' | 'code', action: () => Promise<LicenceView>, done: string) => {
    setBusy(kind);
    setError(undefined);
    try {
      await withSecondFactor(action);
      toast.show({ title: done, tone: 'success' });
      if (kind === 'code') setCode('');
      reload();
    } catch (failure) {
      if (!(failure instanceof SecondFactorCancelled)) setError(messageOf(failure, t));
    } finally {
      setBusy(undefined);
    }
  };

  let content: ReactNode;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('licence.page.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const view = data.value;
    const details = view.details;
    const when = (iso: string) => displayDateTime(new Date(iso));
    content = (
      <>
        <p className="staff-row__states">
          <Badge tone={TONE[view.state]}>{t(`licence.page.state.${view.state}`)}</Badge>
          {view.daysLeft === null || view.daysLeft === 0 ? null : (
            <Badge tone="neutral">{t('licence.page.daysLeft', { count: view.daysLeft })}</Badge>
          )}
        </p>
        {view.restrictedFrom === null || view.state === 'RESTRICTED' ? null : (
          <p className="console-notice console-notice--warning">
            {t('licence.page.pendingRestriction', when(view.restrictedFrom))}
          </p>
        )}
        {view.problem === null ? null : (
          <p className="console-notice console-notice--danger">
            {t(`licence.page.problem.${view.problem}`)}
          </p>
        )}
        {details?.reason === null || details?.reason === undefined ? null : (
          <p>{t('licence.page.reason', { reason: details.reason })}</p>
        )}
        {view.validUntil === null ? null : (
          <p className="dashboard-section__hint">
            {t('licence.page.validUntil', when(view.validUntil))}
          </p>
        )}
        {details?.reactivatedUntil === null || details?.reactivatedUntil === undefined ? null : (
          <p className="dashboard-section__hint">
            {t('licence.page.reactivatedUntil', when(details.reactivatedUntil))}
          </p>
        )}
        {view.enforced ? null : (
          <p className="dashboard-section__hint">{t('licence.page.notEnforced')}</p>
        )}
        {details === null ? null : (
          <dl className="licence-facts">
            <dt>{t('licence.page.plan')}</dt>
            <dd>{details.plan ?? '—'}</dd>
            <dt>{t('licence.page.modules')}</dt>
            <dd>
              {details.modules.length === 0
                ? '—'
                : details.modules.map((module) => t(`licence.page.module.${module}`)).join(', ')}
            </dd>
            <dt>{t('licence.page.devices')}</dt>
            <dd>
              <ul className="licence-devices">
                {DEVICE_KINDS.map((kind) => (
                  <li key={kind}>
                    {t(`licence.page.device.${kind}`)}:{' '}
                    {details.deviceLimits === null
                      ? String(details.deviceCounts[kind] ?? 0)
                      : t('licence.page.deviceUse', {
                          used: details.deviceCounts[kind] ?? 0,
                          limit: details.deviceLimits[kind],
                        })}
                  </li>
                ))}
              </ul>
            </dd>
          </dl>
        )}
        {owner ? (
          <div className="device-group">
            <Button
              variant="secondary"
              loading={busy === 'check'}
              disabled={busy !== undefined}
              onClick={() => {
                void act('check', () => controller.api.checkLicence(), t('licence.page.checked'));
              }}
            >
              {t('licence.page.check')}
            </Button>
            <form
              className="console-form"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void act(
                  'code',
                  () => controller.api.reactivateLicence({ body: { code: code.trim() } }),
                  t('licence.page.reactivated'),
                );
              }}
            >
              <TextField
                label={t('licence.page.code')}
                hint={t('licence.page.codeHint')}
                value={code}
                maxLength={24}
                autoComplete="off"
                onChange={(event) => {
                  setCode(event.target.value);
                }}
              />
              <Button
                type="submit"
                loading={busy === 'code'}
                disabled={busy !== undefined || code.trim().length < 16}
              >
                {t('licence.page.reactivate')}
              </Button>
            </form>
            {error === undefined ? null : (
              <p role="alert" className="console-notice console-notice--danger">
                {error}
              </p>
            )}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-licence">
      <h2 id="dashboard-licence" className="dashboard-section__heading">
        {t('licence.page.title')}
      </h2>
      <p className="dashboard-section__hint">{t('licence.page.intro')}</p>
      {content}
      {dialog}
    </section>
  );
}
