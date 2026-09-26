import type { StaffTile } from '@rp/contracts';
import { Button, EmptyState, ErrorState, LoadingState, PinPad } from '@rp/ui-web';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useConsole, useConsoleState } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';

type Tiles =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly staff: readonly StaffTile[] };

/**
 * The shared-terminal login (AUTH-001, AUTH-004): pick yourself from the tiles, then enter your
 * PIN on the pad, by touch or keyboard.
 */
export function LoginScreen() {
  const t = useT();
  const controller = useConsole();
  const { notice } = useConsoleState();
  const navigate = useNavigate();
  const [tiles, setTiles] = useState<Tiles>({ kind: 'loading' });
  const [selected, setSelected] = useState<StaffTile | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchTiles = useCallback(async (): Promise<Tiles> => {
    try {
      return { kind: 'ready', staff: await controller.staffTiles() };
    } catch (caught) {
      return { kind: 'failed', message: messageOf(caught, t) };
    }
  }, [controller, t]);

  useEffect(() => {
    let current = true;
    void fetchTiles().then((result) => {
      if (current) setTiles(result);
    });
    return () => {
      current = false;
    };
  }, [fetchTiles]);

  async function signIn(person: StaffTile, pin: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await controller.signIn(person.staffId, pin);
      await navigate('/', { replace: true });
    } catch (caught) {
      setError(messageOf(caught, t));
    } finally {
      setBusy(false);
    }
  }

  const noticeText =
    notice === 'signedOutInactive'
      ? t('login.signedOutInactive')
      : notice === 'signedOut'
        ? t('login.signedOut')
        : undefined;

  if (selected !== undefined) {
    return (
      <main className="console-center">
        <section className="console-panel console-login">
          <h1 className="console-title">{t('login.pinFor', { name: selected.displayName })}</h1>
          <PinPad
            label={t('login.pinFor', { name: selected.displayName })}
            onComplete={(pin) => {
              void signIn(selected, pin);
            }}
            error={error}
            busy={busy}
            autoFocus
          />
          <Button
            variant="ghost"
            onClick={() => {
              setSelected(undefined);
              setError(null);
            }}
          >
            {t('login.notYou')}
          </Button>
        </section>
      </main>
    );
  }

  return (
    <main className="console-center">
      <section className="console-panel console-login">
        <h1 className="console-title">{t('login.title')}</h1>
        {noticeText === undefined ? null : (
          <p className="console-notice" role="status">
            {noticeText}
          </p>
        )}
        {tiles.kind === 'loading' ? <LoadingState title={t('states.loading')} /> : null}
        {tiles.kind === 'failed' ? (
          <ErrorState
            title={t('states.error')}
            description={tiles.message}
            onRetry={() => {
              setTiles({ kind: 'loading' });
              void fetchTiles().then(setTiles);
            }}
            retryLabel={t('states.retry')}
          />
        ) : null}
        {tiles.kind === 'ready' && tiles.staff.length === 0 ? (
          <EmptyState title={t('states.empty')} description={t('login.noStaff')} />
        ) : null}
        {tiles.kind === 'ready' && tiles.staff.length > 0 ? (
          <ul className="console-tiles">
            {tiles.staff.map((person) => (
              <li key={person.staffId}>
                <button
                  type="button"
                  className="console-tile"
                  onClick={() => {
                    controller.dismissNotice();
                    setSelected(person);
                  }}
                >
                  <span className="console-tile__name">{person.displayName}</span>
                  <span className="console-tile__role">{t(`roles.${person.role}`)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </main>
  );
}
