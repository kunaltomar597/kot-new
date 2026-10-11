import type { OnboardingResponse, OnboardingStep } from '@rp/contracts';
import { Badge, Button, ErrorState, LoadingState, TextField, useToast } from '@rp/ui-web';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { useConsole, useConsoleState } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { grantOf } from '../../app/modes.js';
import { useLive } from '../../app/use-live.js';
import { SecondFactorCancelled, useSecondFactor } from '../../owner/second-factor.js';
import { GoLivePanel } from './GoLivePanel.js';
import { setupCounts, STEP_PAGES } from './setup-view.js';

const STATUS_TONE = { DONE: 'success', SKIPPED: 'neutral', TODO: 'warning' } as const;

/** Activating the PC with the vendor's code (ONB-003): the Owner's, with their second factor. */
function Activation({ view, reload }: { view: OnboardingResponse; reload: () => void }) {
  const t = useT();
  const controller = useConsole();
  const { person } = useConsoleState();
  const toast = useToast();
  const { withSecondFactor, dialog } = useSecondFactor();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const owner = person !== undefined && grantOf(person, 'LICENSE_MANAGE') !== 'DENY';
  const { activation } = view;

  let body: ReactNode;
  if (activation.activated) {
    body = (
      <p className="console-notice console-notice--success">
        {t('setupPage.activation.done', { name: activation.installationName ?? '' })}
      </p>
    );
  } else if (!activation.configured) {
    body = <p className="dashboard-section__hint">{t('setupPage.activation.notConfigured')}</p>;
  } else if (!owner) {
    body = <p className="dashboard-section__hint">{t('setupPage.activation.ownerOnly')}</p>;
  } else {
    body = (
      <form
        className="console-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          withSecondFactor(() =>
            controller.api.activateInstallation({ body: { code: code.trim() } }),
          ).then(
            (activated) => {
              setBusy(false);
              setCode('');
              toast.show({
                title: t('setupPage.activation.done', { name: activated.installationName }),
                tone: 'success',
              });
              reload();
            },
            (failure: unknown) => {
              setBusy(false);
              if (!(failure instanceof SecondFactorCancelled)) setError(messageOf(failure, t));
            },
          );
        }}
      >
        <TextField
          label={t('setupPage.activation.code')}
          hint={t('setupPage.activation.codeHint')}
          value={code}
          maxLength={24}
          autoComplete="off"
          onChange={(event) => {
            setCode(event.target.value);
          }}
        />
        <Button type="submit" loading={busy} disabled={busy || code.trim().length < 16}>
          {t('setupPage.activation.activate')}
        </Button>
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
      </form>
    );
  }
  return (
    <section className="device-group" aria-labelledby="setup-activation">
      <h3 id="setup-activation" className="device-group__heading">
        {t('setupPage.activation.title')}
      </h3>
      {body}
      {dialog}
    </section>
  );
}

/**
 * The first-run setup (ONB-004, P7-07a): the 11 steps in order, each with what it is for, whether
 * it is done (from what is set up, so it resumes wherever it stopped) and the page that does it.
 * The invoice look and the go-live test are confirmed here; phones and QR ordering may be skipped.
 */
export function SetupScreen() {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { data, reload } = useLive(
    () => controller.api.getOnboarding(),
    (type) =>
      type === 'SettingsChanged' || type === 'RestaurantChanged' || type === 'MenuPublished',
  );
  const [busy, setBusy] = useState<OnboardingStep | undefined>();

  const mark = (step: OnboardingStep, status: 'DONE' | 'SKIPPED' | 'TODO') => {
    setBusy(step);
    controller.api.markOnboardingStep({ params: { step }, body: { status } }).then(
      () => {
        setBusy(undefined);
        reload();
      },
      (failure: unknown) => {
        setBusy(undefined);
        toast.show({ title: messageOf(failure, t), tone: 'danger' });
      },
    );
  };

  let content: ReactNode;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('setupPage.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const view = data.value;
    const { finished, total } = setupCounts(view);
    content = (
      <>
        <Activation view={view} reload={reload} />
        <p
          className={
            view.complete ? 'console-notice console-notice--success' : 'dashboard-section__hint'
          }
        >
          {view.complete ? t('setupPage.complete') : t('setupPage.progress', { finished, total })}
        </p>
        <ol className="setup-steps" aria-label={t('setupPage.steps')}>
          {view.steps.map((entry, index) => (
            <li key={entry.step} className="staff-row">
              <div className="staff-row__who">
                <h4 className="staff-row__name">
                  {t('setupPage.stepTitle', {
                    number: index + 1,
                    title: t(`setupPage.step.${entry.step}.title`),
                  })}
                </h4>
                <p className="staff-row__contact">{t(`setupPage.step.${entry.step}.hint`)}</p>
                <p className="staff-row__states">
                  <Badge tone={STATUS_TONE[entry.status]}>
                    {t(`setupPage.status.${entry.status}`)}
                  </Badge>
                </p>
              </div>
              <div className="staff-row__actions">
                <Link className="console-link" to={STEP_PAGES[entry.step]}>
                  {t(`setupPage.step.${entry.step}.open`)}
                </Link>
                {entry.confirmable && entry.status === 'TODO' && entry.ready ? (
                  <Button
                    variant="secondary"
                    loading={busy === entry.step}
                    disabled={busy !== undefined}
                    onClick={() => {
                      mark(entry.step, 'DONE');
                    }}
                  >
                    {t(
                      entry.step === 'GO_LIVE'
                        ? 'setupPage.step.GO_LIVE.confirm'
                        : 'setupPage.step.INVOICE.confirm',
                    )}
                  </Button>
                ) : null}
                {entry.skippable && entry.status === 'TODO' ? (
                  <Button
                    variant="ghost"
                    disabled={busy !== undefined}
                    onClick={() => {
                      mark(entry.step, 'SKIPPED');
                    }}
                  >
                    {t('setupPage.skip')}
                  </Button>
                ) : null}
                {(entry.confirmable && entry.status === 'DONE') || entry.status === 'SKIPPED' ? (
                  <Button
                    variant="ghost"
                    disabled={busy !== undefined}
                    onClick={() => {
                      mark(entry.step, 'TODO');
                    }}
                  >
                    {t('setupPage.undo')}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
        {view.steps.find((entry) => entry.step === 'GO_LIVE')?.status === 'TODO' ? (
          <GoLivePanel onChange={reload} />
        ) : null}
      </>
    );
  }

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-setup">
      <h2 id="dashboard-setup" className="dashboard-section__heading">
        {t('setupPage.title')}
      </h2>
      <p className="dashboard-section__hint">{t('setupPage.intro')}</p>
      <p>
        <Link className="console-link" to="/manage/setup/readiness">
          {t('setupPage.readinessLink')}
        </Link>
      </p>
      {content}
    </section>
  );
}

/** On the Overview until the setup is done: how far it is, and the way back to it. */
export function SetupBanner() {
  const { person } = useConsoleState();
  if (person === undefined || grantOf(person, 'OPERATIONS_CONFIGURE') === 'DENY') return null;
  return <SetupProgress />;
}

function SetupProgress() {
  const t = useT();
  const controller = useConsole();
  const { data } = useLive(
    () => controller.api.getOnboarding(),
    () => false,
  );
  if (data.status !== 'ready' || data.value.complete) return null;
  const { finished, total } = setupCounts(data.value);
  return (
    <p className="console-notice console-notice--info">
      {t('setupPage.banner', { finished, total })}{' '}
      <Link className="console-link" to="/manage/setup">
        {t('setupPage.continue')}
      </Link>
    </p>
  );
}
