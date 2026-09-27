import type { AlertView, LoginResponse } from '@rp/contracts';
import { describeAlert } from '@rp/ordering';
import { useToast } from '@rp/ui-web';
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useConsole } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { type LiveData, useLive } from '../app/use-live.js';
import { ALERT_EVENTS, arrivals } from './alert-view.js';

export type AlertPerson = LoginResponse['staff'];

/** What is open over the screen: the alert centre, or a manager's nudge. */
export type AlertPanel = 'alerts' | 'nudge' | undefined;

export interface AlertsState {
  readonly person: AlertPerson;
  readonly alerts: LiveData<readonly AlertView[]>;
  /** Names by staff id, for "For Ravi"; empty until read. */
  readonly names: ReadonlyMap<string, string>;
  readonly reload: () => void;
  /** Acknowledges the alert for everyone (NTF-004); rejects with the server's reason. */
  readonly acknowledge: (alertId: string) => Promise<void>;
  readonly panel: AlertPanel;
  readonly setPanel: (panel: AlertPanel) => void;
}

const AlertsContext = createContext<AlertsState | null>(null);

/** The signed-in person's alerts in the POS and manage modes; null elsewhere. */
export function useAlerts(): AlertsState | null {
  return use(AlertsContext);
}

/**
 * The open alerts for the person signed in on the console (P2-06c, MGR-008): every open alert for
 * managers and the Owner, their own for everyone else, read again after each alert event and after
 * a reconnect (NTF-006). An alert that newly asks for the person, or was escalated to them, pops up
 * as a toast; the header button counts them.
 */
export function AlertsProvider({ person, children }: { person: AlertPerson; children: ReactNode }) {
  const controller = useConsole();
  const t = useT();
  const toast = useToast();
  const { data: alerts, reload } = useLive<readonly AlertView[]>(
    async () => (await controller.api.listAlerts()).alerts,
    (type) => ALERT_EVENTS.has(type),
  );
  const [names, setNames] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [panel, setPanel] = useState<AlertPanel>();
  const seen = useRef<ReadonlyMap<string, boolean> | undefined>(undefined);

  useEffect(() => {
    let live = true;
    controller.staffTiles().then(
      (tiles) => {
        if (live) setNames(new Map(tiles.map((tile) => [tile.staffId, tile.displayName])));
      },
      () => {
        // Without names the alerts still show, only without "For …".
      },
    );
    return () => {
      live = false;
    };
  }, [controller]);

  useEffect(() => {
    if (alerts.status !== 'ready') return;
    const changed = arrivals(seen.current, alerts.value, person.id);
    seen.current = changed.seen;
    for (const alert of changed.announce) {
      const { title, detail } = describeAlert(alert, t);
      toast.show({
        title,
        ...(detail !== null && { description: detail }),
        // An escalation stays until dismissed (danger toasts do); the rest go after a while.
        tone: alert.escalatedTo.includes(person.id) ? 'danger' : 'warning',
        action: {
          label: t('alerts.centre.show'),
          onAction: () => {
            setPanel('alerts');
          },
        },
      });
    }
  }, [alerts, person.id, t, toast]);

  const acknowledge = useCallback(
    async (alertId: string) => {
      await controller.api.acknowledgeAlert({ params: { alertId } });
      reload();
    },
    [controller, reload],
  );

  const value = useMemo(
    () => ({ person, alerts, names, reload, acknowledge, panel, setPanel }),
    [person, alerts, names, reload, acknowledge, panel],
  );
  return <AlertsContext value={value}>{children}</AlertsContext>;
}
