import { ApiRequestError } from '@rp/api-client';
import type { SecondFactor } from '@rp/contracts';
import { Button, Dialog, LoadingState, TextField } from '@rp/ui-web';
import { type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { useConsole } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { formatPairingCode, messageOf } from '../app/messages.js';

/** The Owner closed the confirmation: the action is not taken. */
export class SecondFactorCancelled extends Error {
  constructor() {
    super('The Owner did not confirm the second factor');
    this.name = 'SecondFactorCancelled';
  }
}

/** Runs an action that may need the Owner's second factor (see `useSecondFactor`). */
export type WithSecondFactor = <T>(action: () => Promise<T>) => Promise<T>;

interface Pending {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Owner-only actions behind the second factor (AUTH-006): the action is tried; when the server
 * answers SECOND_FACTOR_REQUIRED, the Owner confirms their password and an authenticator code (or
 * a recovery code) here, and the action is sent once more. The confirmation then holds for
 * `auth.stepUpMinutes`, so the next Owner-only actions go straight through.
 */
export function useSecondFactor(): { withSecondFactor: WithSecondFactor; dialog: ReactNode } {
  const [pending, setPending] = useState<Pending | undefined>();

  const withSecondFactor = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof ApiRequestError) || error.code !== 'SECOND_FACTOR_REQUIRED') {
        throw error;
      }
      await new Promise<void>((resolve, reject) => {
        setPending({ resolve, reject });
      });
      return action();
    }
  }, []);

  const dialog =
    pending === undefined ? null : (
      <SecondFactorDialog
        pending={pending}
        onDone={() => {
          setPending(undefined);
        }}
      />
    );
  return { withSecondFactor, dialog };
}

type Setup = 'checking' | 'ready' | 'missing';

function SecondFactorDialog({ pending, onDone }: { pending: Pending; onDone: () => void }) {
  const t = useT();
  const controller = useConsole();
  const navigate = useNavigate();
  const formId = useId();
  const [setup, setSetup] = useState<Setup>('checking');
  const [password, setPassword] = useState('');
  const [kind, setKind] = useState<SecondFactor['kind']>('TOTP');
  const [code, setCode] = useState('');
  const [codeProblem, setCodeProblem] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // Without a password and an authenticator there is nothing to confirm with: say where to set
  // them up. When this cannot be read, the form shows and the server says what is wrong.
  useEffect(() => {
    let current = true;
    controller.api.getOwnerSecurity().then(
      (security) => {
        if (current)
          setSetup(security.hasPassword && security.hasAuthenticator ? 'ready' : 'missing');
      },
      () => {
        if (current) setSetup('ready');
      },
    );
    return () => {
      current = false;
    };
  }, [controller]);

  const cancel = () => {
    pending.reject(new SecondFactorCancelled());
    onDone();
  };

  const confirm = async () => {
    const valid = kind === 'TOTP' ? /^\d{6}$/.test(code) : /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code);
    if (!valid) {
      setCodeProblem(
        t(kind === 'TOTP' ? 'secondFactor.codeInvalid' : 'secondFactor.recoveryInvalid'),
      );
      return;
    }
    setCodeProblem(undefined);
    setError(undefined);
    setBusy(true);
    try {
      await controller.api.stepUp({ body: { password, secondFactor: { kind, code } } });
      pending.resolve();
      onDone();
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  const switchKind = () => {
    setKind(kind === 'TOTP' ? 'RECOVERY_CODE' : 'TOTP');
    setCode('');
    setCodeProblem(undefined);
  };

  let body: ReactNode;
  let footer: ReactNode = null;
  if (setup === 'checking') {
    body = <LoadingState title={t('states.loading')} />;
  } else if (setup === 'missing') {
    body = <p className="console-notice">{t('secondFactor.notSetUp')}</p>;
    footer = (
      <>
        <Button variant="secondary" onClick={cancel}>
          {t('secondFactor.cancel')}
        </Button>
        <Button
          onClick={() => {
            cancel();
            void navigate('/manage/security');
          }}
        >
          {t('secondFactor.openSecurity')}
        </Button>
      </>
    );
  } else {
    body = (
      <form
        id={formId}
        className="console-form"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <TextField
          label={t('secondFactor.password')}
          type="password"
          autoComplete="current-password"
          value={password}
          required
          data-autofocus
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
        {kind === 'TOTP' ? (
          <TextField
            key="totp"
            label={t('secondFactor.code')}
            hint={t('secondFactor.codeHint')}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            required
            error={codeProblem}
            onChange={(event) => {
              setCode(event.target.value.replace(/\D/g, '').slice(0, 6));
            }}
          />
        ) : (
          <TextField
            key="recovery"
            label={t('secondFactor.recoveryCode')}
            hint={t('secondFactor.recoveryHint')}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={9}
            value={code}
            required
            error={codeProblem}
            onChange={(event) => {
              // Recovery codes are typed like pairing codes: four characters, a dash, four more.
              setCode(formatPairingCode(event.target.value));
            }}
          />
        )}
        <Button variant="ghost" onClick={switchKind} disabled={busy}>
          {t(kind === 'TOTP' ? 'secondFactor.useRecovery' : 'secondFactor.useCode')}
        </Button>
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
      </form>
    );
    footer = (
      <>
        <Button variant="secondary" onClick={cancel} disabled={busy}>
          {t('secondFactor.cancel')}
        </Button>
        <Button type="submit" form={formId} loading={busy} disabled={password.length < 12}>
          {t('secondFactor.confirm')}
        </Button>
      </>
    );
  }

  return (
    <Dialog
      open
      onClose={cancel}
      dismissible={!busy}
      title={t('secondFactor.title')}
      description={t('secondFactor.description')}
      footer={footer}
    >
      {body}
    </Dialog>
  );
}
