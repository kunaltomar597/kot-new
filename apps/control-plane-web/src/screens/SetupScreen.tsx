import type { VendorSetupResponse } from '@rp/contracts/control-plane';
import { Button, QrCode, TextField } from '@rp/ui-web';
import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useApi } from '../app/services.js';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The base 32 secret in groups of four, easier to type into an authenticator by hand. */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

/**
 * Setting up an account from its one-time link (`/setup#<token>`; the token stays in the
 * fragment, so it never reaches a server log): a password, then an authenticator app, proven
 * with a code. Only then can the person sign in (VCP-001, SEC-018).
 */
export function SetupScreen() {
  const t = useT();
  const api = useApi();
  const location = useLocation();
  const token = location.hash.replace(/^#/, '');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [authenticator, setAuthenticator] = useState<VendorSetupResponse | undefined>();
  const [code, setCode] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const run = (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    work().then(
      () => {
        setBusy(false);
      },
      (failure: unknown) => {
        setBusy(false);
        setError(messageOf(failure, t));
      },
    );
  };

  let content;
  if (!TOKEN.test(token)) {
    content = <p className="cp-notice cp-notice--danger">{t('vendorApp.setup.badLink')}</p>;
  } else if (done) {
    content = (
      <>
        <p className="cp-notice cp-notice--success">{t('vendorApp.setup.done')}</p>
        <Link className="cp-link" to="/sign-in">
          {t('vendorApp.setup.signIn')}
        </Link>
      </>
    );
  } else if (authenticator === undefined) {
    const tooShort = password.length > 0 && password.length < 12;
    const mismatch = repeat.length > 0 && repeat !== password;
    content = (
      <form
        className="cp-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (password.length < 12 || repeat !== password || busy) return;
          run(async () => {
            setAuthenticator(await api.vendorSetup({ body: { token, password } }));
          });
        }}
      >
        <p className="cp-hint">{t('vendorApp.setup.passwordIntro')}</p>
        <TextField
          label={t('vendorApp.setup.password')}
          hint={t('vendorApp.setup.passwordHint')}
          type="password"
          autoComplete="new-password"
          value={password}
          error={tooShort ? t('vendorApp.setup.passwordShort') : undefined}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
        <TextField
          label={t('vendorApp.setup.repeat')}
          type="password"
          autoComplete="new-password"
          value={repeat}
          error={mismatch ? t('vendorApp.setup.mismatch') : undefined}
          onChange={(event) => {
            setRepeat(event.target.value);
          }}
        />
        <Button type="submit" loading={busy} disabled={password.length < 12 || repeat !== password}>
          {t('vendorApp.setup.next')}
        </Button>
      </form>
    );
  } else {
    content = (
      <form
        className="cp-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!/^\d{6}$/.test(code) || busy) return;
          run(async () => {
            await api.vendorSetupConfirm({ body: { token, code } });
            // The link is used up: take it out of the address bar and the history.
            globalThis.history.replaceState(null, '', '/setup');
            setDone(true);
          });
        }}
      >
        <p className="cp-hint">{t('vendorApp.setup.authenticatorIntro')}</p>
        <QrCode value={authenticator.otpauthUri} label={t('vendorApp.setup.qrLabel')} />
        <p className="cp-hint">{t('vendorApp.setup.byHand')}</p>
        <output className="cp-secret__value" aria-label={t('vendorApp.setup.secretLabel')}>
          {groupSecret(authenticator.secret)}
        </output>
        <TextField
          label={t('vendorApp.setup.code')}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(event) => {
            setCode(event.target.value.replace(/\D/g, ''));
          }}
        />
        <Button type="submit" loading={busy} disabled={!/^\d{6}$/.test(code)}>
          {t('vendorApp.setup.finish')}
        </Button>
      </form>
    );
  }

  return (
    <main className="cp-center">
      <section className="cp-auth" aria-labelledby="cp-setup-title">
        <h1 id="cp-setup-title" className="cp-auth__title">
          {t('vendorApp.setup.title')}
        </h1>
        {content}
        {error === undefined ? null : (
          <p role="alert" className="cp-notice cp-notice--danger">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
