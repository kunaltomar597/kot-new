import { Button, TextField } from '@rp/ui-web';
import { useState } from 'react';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useApi, useSession, useSessionStore } from '../app/services.js';

/** Email, password and the authenticator's code, always together: MFA is never optional (VCP-001). */
export function SignInScreen() {
  const t = useT();
  const api = useApi();
  const store = useSessionStore();
  const session = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const ended = session.status === 'signedOut' && session.ended;
  const complete = email.trim() !== '' && password !== '' && /^\d{6}$/.test(code);

  return (
    <main className="cp-center">
      <form
        className="cp-auth"
        aria-labelledby="cp-sign-in-title"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!complete || busy) return;
          setBusy(true);
          setError(undefined);
          api.vendorSignIn({ body: { email: email.trim(), password, code } }).then(
            (started) => {
              store.started(started);
            },
            (failure: unknown) => {
              setBusy(false);
              setCode('');
              setError(messageOf(failure, t));
            },
          );
        }}
      >
        <h1 id="cp-sign-in-title" className="cp-auth__title">
          {t('vendorApp.name')}
        </h1>
        <p className="cp-hint">{t('vendorApp.signIn.intro')}</p>
        {ended ? <p className="cp-notice cp-notice--info">{t('vendorApp.signIn.ended')}</p> : null}
        <TextField
          label={t('vendorApp.signIn.email')}
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
        <TextField
          label={t('vendorApp.signIn.password')}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
        <TextField
          label={t('vendorApp.signIn.code')}
          hint={t('vendorApp.signIn.codeHint')}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(event) => {
            setCode(event.target.value.replace(/\D/g, ''));
          }}
        />
        {error === undefined ? null : (
          <p role="alert" className="cp-notice cp-notice--danger">
            {error}
          </p>
        )}
        <Button type="submit" loading={busy} disabled={!complete || busy} fullWidth>
          {t('vendorApp.signIn.submit')}
        </Button>
      </form>
    </main>
  );
}
