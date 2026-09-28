import type { OwnerSecurityResponse, TotpEnrollmentResponse } from '@rp/contracts';
import { timeOfDayOf } from '@rp/domain';
import {
  Badge,
  Button,
  Card,
  Dialog,
  ErrorState,
  LoadingState,
  QrCode,
  TextField,
  useToast,
} from '@rp/ui-web';
import { useId, useState } from 'react';
import { useConsole } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useLive } from '../app/use-live.js';
import { SecondFactorCancelled, useSecondFactor, type WithSecondFactor } from './second-factor.js';

/** The Owner password's shortest length (AUTH-006, `OwnerPassword` in `@rp/contracts`). */
const PASSWORD_MIN = 12;

type Open =
  | { readonly kind: 'PASSWORD' }
  | { readonly kind: 'AUTHENTICATOR'; readonly enrolment: TotpEnrollmentResponse };

/**
 * The Owner's sign-in security (P4-02a, AUTH-006): the password and the authenticator app that
 * protect Owner-only actions such as adding a manager, and how many one-time recovery codes are
 * left. Setting them up the first time needs nothing more; changing them needs the second factor
 * again. Secrets are never shown except the new authenticator key, once, while it is added.
 */
export function OwnerSecurityScreen() {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { withSecondFactor, dialog: secondFactorDialog } = useSecondFactor();
  const { data, reload } = useLive(
    () => controller.api.getOwnerSecurity(),
    () => false,
  );
  const [open, setOpen] = useState<Open | undefined>();
  const [starting, setStarting] = useState(false);

  const close = () => {
    setOpen(undefined);
    reload();
  };

  /** A new authenticator key; replacing a working one asks for the second factor first. */
  const startAuthenticator = async () => {
    setStarting(true);
    try {
      const enrolment = await withSecondFactor(() => controller.api.enrollOwnerTotp());
      setOpen({ kind: 'AUTHENTICATOR', enrolment });
    } catch (failure) {
      if (!(failure instanceof SecondFactorCancelled)) {
        toast.show({ title: messageOf(failure, t), tone: 'danger' });
      }
    } finally {
      setStarting(false);
    }
  };

  let content;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('ownerSecurity.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const security = data.value;
    content = (
      <div className="security-cards">
        <Card className="security-card" title={t('ownerSecurity.password.title')}>
          <p className="security-card__state">
            <SetUpBadge done={security.hasPassword} />
            {security.hasPassword
              ? t('ownerSecurity.password.set')
              : t('ownerSecurity.password.notSet')}
          </p>
          <Button
            variant={security.hasPassword ? 'secondary' : 'primary'}
            onClick={() => {
              setOpen({ kind: 'PASSWORD' });
            }}
          >
            {security.hasPassword
              ? t('ownerSecurity.password.changeAction')
              : t('ownerSecurity.password.setAction')}
          </Button>
        </Card>
        <Card className="security-card" title={t('ownerSecurity.authenticator.title')}>
          <p className="security-card__state">
            <SetUpBadge done={security.hasAuthenticator} />
            {security.hasAuthenticator
              ? t('ownerSecurity.authenticator.set')
              : t('ownerSecurity.authenticator.notSet')}
          </p>
          <Button
            variant={security.hasAuthenticator ? 'secondary' : 'primary'}
            loading={starting}
            onClick={() => {
              void startAuthenticator();
            }}
          >
            {security.hasAuthenticator
              ? t('ownerSecurity.authenticator.replace')
              : t('ownerSecurity.authenticator.add')}
          </Button>
        </Card>
        {security.hasAuthenticator ? (
          <Card className="security-card" title={t('ownerSecurity.recovery.title')}>
            <p className="security-card__state">
              {t('ownerSecurity.recovery.left', { count: security.recoveryCodesLeft })}
            </p>
            <p className="dashboard-section__hint">{t('ownerSecurity.recovery.renew')}</p>
          </Card>
        ) : null}
        {security.secondFactorValidUntil === null ? null : (
          <p className="dashboard-section__hint security-cards__wide">
            {t('ownerSecurity.confirmedUntil', {
              time: timeOfDayOf(new Date(security.secondFactorValidUntil)),
            })}
          </p>
        )}
      </div>
    );
  }

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-security">
      <h2 id="dashboard-security" className="dashboard-section__heading">
        {t('ownerSecurity.title')}
      </h2>
      <p className="dashboard-section__hint">{t('ownerSecurity.intro')}</p>
      {content}
      {open?.kind === 'PASSWORD' && data.status === 'ready' ? (
        <PasswordDialog
          security={data.value}
          withSecondFactor={withSecondFactor}
          onSaved={(message) => {
            toast.show({ title: message, tone: 'success' });
            close();
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'AUTHENTICATOR' ? (
        <AuthenticatorDialog
          enrolment={open.enrolment}
          onDone={() => {
            toast.show({ title: t('ownerSecurity.authenticator.done'), tone: 'success' });
            close();
          }}
          onClose={close}
        />
      ) : null}
      {secondFactorDialog}
    </section>
  );
}

/** Whether a part is set up, in words beside the colour (NFR-U05). */
function SetUpBadge({ done }: { done: boolean }) {
  const t = useT();
  return done ? (
    <Badge tone="success">{t('ownerSecurity.setUp')}</Badge>
  ) : (
    <Badge tone="warning">{t('ownerSecurity.notSetUp')}</Badge>
  );
}

/** Sets the first password, or changes it with the current one (and the second factor). */
function PasswordDialog({
  security,
  withSecondFactor,
  onSaved,
  onClose,
}: {
  security: OwnerSecurityResponse;
  withSecondFactor: WithSecondFactor;
  onSaved: (message: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const formId = useId();
  const changing = security.hasPassword;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const tooShort = next.length < PASSWORD_MIN;
  const mismatch = !tooShort && next !== again;
  const currentMissing = changing && current.length < PASSWORD_MIN;

  const save = async () => {
    setSubmitted(true);
    if (tooShort || mismatch || currentMissing) return;
    setError(undefined);
    setBusy(true);
    try {
      const body = changing
        ? { currentPassword: current, newPassword: next }
        : { newPassword: next };
      await withSecondFactor(() => controller.api.setOwnerPassword({ body }));
      onSaved(changing ? t('ownerSecurity.password.changed') : t('ownerSecurity.password.saved'));
    } catch (failure) {
      if (!(failure instanceof SecondFactorCancelled)) setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={
        changing ? t('ownerSecurity.password.changeAction') : t('ownerSecurity.password.setAction')
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('ownerSecurity.password.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('ownerSecurity.password.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="console-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {changing ? (
          <TextField
            label={t('ownerSecurity.password.current')}
            type="password"
            autoComplete="current-password"
            value={current}
            required
            data-autofocus
            error={submitted && currentMissing ? t('ownerSecurity.password.tooShort') : undefined}
            onChange={(event) => {
              setCurrent(event.target.value);
            }}
          />
        ) : null}
        <TextField
          label={t('ownerSecurity.password.new')}
          hint={t('ownerSecurity.password.newHint')}
          type="password"
          autoComplete="new-password"
          maxLength={256}
          value={next}
          required
          data-autofocus={changing ? undefined : true}
          error={submitted && tooShort ? t('ownerSecurity.password.tooShort') : undefined}
          onChange={(event) => {
            setNext(event.target.value);
          }}
        />
        <TextField
          label={t('ownerSecurity.password.again')}
          type="password"
          autoComplete="new-password"
          maxLength={256}
          value={again}
          required
          error={submitted && mismatch ? t('ownerSecurity.password.mismatch') : undefined}
          onChange={(event) => {
            setAgain(event.target.value);
          }}
        />
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** The base32 key in groups of four, as authenticator apps show and accept it. */
export function groupedKey(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(' ') ?? secret;
}

/**
 * Adds the restaurant to the Owner's authenticator app: a QR code (or the key typed in), then the
 * code the app shows to confirm it; then the ten one-time recovery codes, shown this once and
 * closed only by saying they are saved.
 */
function AuthenticatorDialog({
  enrolment,
  onDone,
  onClose,
}: {
  enrolment: TotpEnrollmentResponse;
  onDone: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const formId = useId();
  const [code, setCode] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[] | undefined>();
  const codeValid = /^\d{6}$/.test(code);

  const confirm = async () => {
    setSubmitted(true);
    if (!codeValid) return;
    setError(undefined);
    setBusy(true);
    try {
      const confirmed = await controller.api.confirmOwnerTotp({ body: { code } });
      setRecoveryCodes(confirmed.recoveryCodes);
    } catch (failure) {
      setError(messageOf(failure, t));
    } finally {
      setBusy(false);
    }
  };

  if (recoveryCodes !== undefined) {
    return (
      <Dialog
        open
        onClose={onDone}
        dismissible={false}
        title={t('ownerSecurity.recovery.saveTitle')}
        description={t('ownerSecurity.recovery.saveDescription')}
        footer={
          <Button onClick={onDone} data-autofocus>
            {t('ownerSecurity.recovery.saved')}
          </Button>
        }
      >
        <ol className="security-codes" aria-label={t('ownerSecurity.recovery.codes')}>
          {recoveryCodes.map((recovery) => (
            <li key={recovery} className="security-codes__code">
              {recovery}
            </li>
          ))}
        </ol>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={t('ownerSecurity.authenticator.add')}
      description={t('ownerSecurity.authenticator.scan')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('ownerSecurity.authenticator.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('ownerSecurity.authenticator.confirm')}
          </Button>
        </>
      }
    >
      <div className="security-enrol">
        <QrCode
          value={enrolment.otpauthUri}
          label={t('ownerSecurity.authenticator.qrLabel')}
          size={208}
        />
        <p className="security-enrol__manual">
          {t('ownerSecurity.authenticator.manual')}{' '}
          <code className="security-enrol__key">{groupedKey(enrolment.secret)}</code>
        </p>
      </div>
      <form
        id={formId}
        className="console-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <TextField
          label={t('ownerSecurity.authenticator.code')}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          required
          data-autofocus
          error={submitted && !codeValid ? t('secondFactor.codeInvalid') : undefined}
          onChange={(event) => {
            setCode(event.target.value.replace(/\D/g, '').slice(0, 6));
          }}
        />
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
