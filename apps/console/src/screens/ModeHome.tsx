import { Button, ErrorState } from '@rp/ui-web';
import { Navigate, useNavigate } from 'react-router';
import { AlertCentre } from '../alerts/AlertCentre.js';
import { useConsoleState } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { homeFor, isStationMode, type Mode, modesFor } from '../app/modes.js';
import { KdsScreen } from '../kds/KdsScreen.js';
import { PosHome } from '../pos/PosHome.js';

/**
 * A mode's start screen: the POS floor (P1-08), the kitchen display (P1-09) and the manager
 * dashboard, which has its alert centre (P2-06c); the rest of the dashboard arrives with P4-01.
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
      {mode === 'pos' ? <PosHome /> : null}
      {mode === 'kds' ? <KdsScreen /> : null}
      {mode === 'manage' ? <ManageHome /> : null}
    </section>
  );
}

/** The manager dashboard so far: the alert centre (MGR-008). */
function ManageHome() {
  const t = useT();
  return (
    <section className="manage-home" aria-labelledby="manage-alerts">
      <h2 id="manage-alerts" className="manage-home__heading">
        {t('alerts.title')}
      </h2>
      <AlertCentre />
      <p className="manage-home__later">{t('alerts.centre.dashboardLater')}</p>
    </section>
  );
}
