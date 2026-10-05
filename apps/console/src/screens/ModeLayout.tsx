import type { PermissionHolder } from '@rp/domain';
import { Button, ConnectionBanner, ThemeRoot } from '@rp/ui-web';
import { useEffect, useRef, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import type { ConsoleSnapshot } from '../app/console-controller.js';
import { useConsole, useConsoleState } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { InactivityTracker } from '../app/inactivity.js';
import { modeOfPath, modesFor } from '../app/modes.js';
import { AlertPanels, AlertsButton } from '../alerts/AlertCentre.js';
import { AlertsProvider } from '../alerts/alerts-context.js';

/** Warn this long before signing an idle person out. */
const WARN_MS = 30_000;
/** Tell the server the person is still here at most this often. */
const KEEP_ALIVE_MS = 60_000;
const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

function bannerStatus(
  connection: ConsoleSnapshot['connection'],
): 'online' | 'reconnecting' | 'offline' {
  if (connection === 'offline') return 'offline';
  if (connection === 'connecting') return 'reconnecting';
  return 'online';
}

/**
 * The frame of every mode: who is signed in, the modes they may open, sign-out, the connection
 * banner (NFR-P11), the inactivity sign-out (AUTH-005) and, on the POS and the dashboard, the
 * person's alerts (P2-06c, MGR-008).
 */
export function ModeLayout() {
  const t = useT();
  const state = useConsoleState();
  const controller = useConsole();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  if (state.phase !== 'paired') return <Navigate to="/pair" replace />;
  const { person, session } = state;
  const status = bannerStatus(state.connection);
  const mode = modeOfPath(pathname);

  const frame = (
    <ThemeRoot className="console-shell" {...(mode === 'kds' && { theme: 'kds' as const })}>
      <header className="console-header">
        <span className="console-header__app">{t('app.name')}</span>
        {person === undefined ? null : <ModeLinks person={person} />}
        <AlertsButton />
        <span className="console-header__device">{state.device?.name}</span>
        {person === undefined ? null : (
          <>
            <span className="console-header__person">
              {t('modes.signedInAs', {
                name: person.displayName,
                role: person.customRole?.name ?? t(`roles.${person.role}`),
              })}
            </span>
            <Button
              variant="secondary"
              onClick={() => {
                void controller.signOut().then(() => navigate('/login', { replace: true }));
              }}
            >
              {t('login.signOut')}
            </Button>
          </>
        )}
      </header>
      <ConnectionBanner
        status={status}
        message={status === 'offline' ? t('connection.offline') : t('connection.connecting')}
      />
      {person !== undefined && session !== undefined ? (
        <InactivityGuard key={session.id} timeoutSeconds={session.inactivityTimeoutSeconds} />
      ) : null}
      <main className="console-main">
        <Outlet />
      </main>
      <AlertPanels />
    </ThemeRoot>
  );
  // The kitchen display has its own flags (KDS-006); the POS and the dashboard show alerts.
  if (person === undefined || mode === 'kds') return frame;
  return (
    <AlertsProvider key={person.id} person={person}>
      {frame}
    </AlertsProvider>
  );
}

function ModeLinks({ person }: { person: PermissionHolder }) {
  const t = useT();
  const modes = modesFor(person);
  if (modes.length < 2) return null;
  return (
    <nav aria-label={t('modes.navigation')} className="console-header__modes">
      {modes.map((mode) => (
        <NavLink key={mode} to={`/${mode}`} className="console-header__mode">
          {t(`modes.${mode}`)}
        </NavLink>
      ))}
    </nav>
  );
}

/** Warns, then signs the person out after the session's inactivity timeout. */
function InactivityGuard({ timeoutSeconds }: { timeoutSeconds: number }) {
  const t = useT();
  const controller = useConsole();
  const navigate = useNavigate();
  const [secondsLeft, setSecondsLeft] = useState<number | undefined>();
  const tracker = useRef<InactivityTracker | undefined>(undefined);

  useEffect(() => {
    const current = new InactivityTracker({
      timeoutMs: timeoutSeconds * 1000,
      warnMs: Math.min(WARN_MS, (timeoutSeconds * 1000) / 2),
      keepAliveMs: KEEP_ALIVE_MS,
      onWarn: setSecondsLeft,
      onActive: () => {
        setSecondsLeft(undefined);
      },
      onKeepAlive: () => {
        void controller.keepAlive();
      },
      onExpire: () => {
        void controller
          .signOut('signedOutInactive')
          .then(() => navigate('/login', { replace: true }));
      },
    });
    tracker.current = current;
    const onInput = (): void => {
      current.activity();
    };
    for (const name of INPUT_EVENTS) window.addEventListener(name, onInput, { passive: true });
    return () => {
      current.stop();
      for (const name of INPUT_EVENTS) window.removeEventListener(name, onInput);
    };
  }, [controller, navigate, timeoutSeconds]);

  if (secondsLeft === undefined) return null;
  return (
    <div className="console-inactivity" role="alert">
      {t('session.inactivityWarning', { seconds: secondsLeft })}
    </div>
  );
}
