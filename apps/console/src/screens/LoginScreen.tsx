import type { StaffTile } from '@rp/contracts';
import { Button, EmptyState, ErrorState, LoadingState, PinPad } from '@rp/ui-web';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useConsole, useConsoleState } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useLive } from '../app/use-live.js';

/**
 * The shared-terminal login (AUTH-001, AUTH-004): pick yourself from the tiles, then enter your
 * PIN on the pad, by touch or keyboard. The tiles follow staff changes made anywhere (P4-02a): a
 * person added on another screen can sign in here at once, and a deactivated one disappears.
 */
export function LoginScreen() {
  const t = useT();
  const controller = useConsole();
  const { notice } = useConsoleState();
  const navigate = useNavigate();
  const { data: tiles, reload } = useLive(
    () => controller.staffTiles(),
    (type) => type === 'RestaurantChanged',
  );
  const [selected, setSelected] = useState<StaffTile | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        {tiles.status === 'loading' ? <LoadingState title={t('states.loading')} /> : null}
        {tiles.status === 'error' ? (
          <ErrorState
            title={t('states.error')}
            description={messageOf(tiles.error, t)}
            onRetry={reload}
            retryLabel={t('states.retry')}
          />
        ) : null}
        {tiles.status === 'ready' && tiles.value.length === 0 ? (
          <EmptyState title={t('states.empty')} description={t('login.noStaff')} />
        ) : null}
        {tiles.status === 'ready' && tiles.value.length > 0 ? (
          <ul className="console-tiles">
            {tiles.value.map((person) => (
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
