import { Button, EmptyState, ErrorState } from '@rp/ui-web';
import { Navigate, useNavigate } from 'react-router';
import { useConsoleState } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { homeFor, isStationMode, type Mode, modesFor } from '../app/modes.js';
import { PosHome } from '../pos/PosHome.js';

/**
 * A mode's start screen: the POS floor (P1-08); the KDS (P1-09) and dashboard (P4-01) screens
 * arrive with their work packages, and until then those modes say so.
 */
export function ModeHome({ mode }: { mode: Mode }) {
  const t = useT();
  const { person, device } = useConsoleState();
  const navigate = useNavigate();
  const name = t(`modes.${mode}`);

  if (person === undefined) {
    // A kitchen screen works for its station without anybody signed in (station mode).
    if (!(mode === 'kds' && isStationMode(device))) return <Navigate to="/login" replace />;
  } else if (!modesFor(person.role).includes(mode)) {
    const home = homeFor(person.role);
    return (
      <ErrorState
        title={t('modes.notAllowed', { mode: name })}
        action={
          <Button
            onClick={() => {
              void navigate(`/${home}`, { replace: true });
            }}
          >
            {t(`modes.${home}`)}
          </Button>
        }
      />
    );
  }

  return (
    <section className="console-mode" aria-labelledby={`mode-${mode}`}>
      <h1 id={`mode-${mode}`} className="console-title">
        {name}
      </h1>
      {mode === 'pos' ? (
        <PosHome />
      ) : (
        <EmptyState title={name} description={t('modes.comingSoon', { mode: name })} />
      )}
    </section>
  );
}
