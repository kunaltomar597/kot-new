import type { AlertView } from '@rp/contracts';
import { grantOf } from '@rp/domain';
import { alertAge, describeAlert } from '@rp/ordering';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  Sheet,
  useToast,
} from '@rp/ui-web';
import { useId, useState } from 'react';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useNow } from '../app/use-now.js';
import { type AlertGroup, alertsForMe, groupAlerts } from './alert-view.js';
import { type AlertsState, useAlerts } from './alerts-context.js';
import { NudgeDialog } from './NudgeDialog.js';

/** Refresh "4 min ago" this often. */
const AGE_REFRESH_MS = 30_000;

/**
 * The alert centre (P2-06c, MGR-008): the open alerts in groups, what asks for the person first,
 * each with Acknowledge (NTF-004), and for managers the nudge to waiters (NTF-008). Live: it reads
 * the alerts again after every alert event.
 */
export function AlertCentre() {
  const state = useAlerts();
  const t = useT();
  const now = useNow(AGE_REFRESH_MS);
  if (state === null) return null;
  const { alerts, person, reload, setPanel } = state;
  const canNudge = grantOf(person, 'STAFF_MANAGE') !== 'DENY';

  let content;
  if (alerts.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (alerts.status === 'error') {
    content = (
      <ErrorState
        title={t('alerts.centre.loadFailed')}
        description={messageOf(alerts.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const groups = groupAlerts(alerts.value, person.id);
    content =
      groups.length === 0 ? (
        <EmptyState icon="bell" title={t('alerts.centre.none')} />
      ) : (
        groups.map(({ group, alerts: members }) => (
          <AlertGroupSection key={group} group={group} alerts={members} state={state} now={now} />
        ))
      );
  }

  return (
    <div className="alert-centre">
      {canNudge ? (
        <div className="alert-centre__actions">
          <Button
            variant="secondary"
            startIcon={<Icon name="send" />}
            onClick={() => {
              setPanel('nudge');
            }}
          >
            {t('alerts.nudge.open')}
          </Button>
        </div>
      ) : null}
      {content}
    </div>
  );
}

function AlertGroupSection({
  group,
  alerts,
  state,
  now,
}: {
  group: AlertGroup;
  alerts: readonly AlertView[];
  state: AlertsState;
  now: number;
}) {
  const t = useT();
  const headingId = useId();
  return (
    <section className="alert-centre__group" aria-labelledby={headingId} data-group={group}>
      <h3 id={headingId} className="alert-centre__heading">
        {t('alerts.centre.groupHeading', {
          group: t(`alerts.centre.groups.${group}`),
          count: alerts.length,
        })}
      </h3>
      <ul className="alert-centre__list">
        {alerts.map((alert) => (
          <li key={alert.id}>
            <AlertRow alert={alert} mine={group === 'mine'} state={state} now={now} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function AlertRow({
  alert,
  mine,
  state,
  now,
}: {
  alert: AlertView;
  mine: boolean;
  state: AlertsState;
  now: number;
}) {
  const t = useT();
  const toast = useToast();
  const [working, setWorking] = useState(false);
  const { title, detail } = describeAlert(alert, t);
  // Whom it is for, when a manager looks over someone else's alert.
  const others = mine
    ? []
    : alert.recipientIds.flatMap((staffId) => state.names.get(staffId) ?? []);

  const acknowledge = async () => {
    setWorking(true);
    try {
      await state.acknowledge(alert.id);
    } catch (error) {
      toast.show({
        title: t('alerts.acknowledgeFailed', { message: messageOf(error, t) }),
        tone: 'danger',
      });
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="alert-row" data-escalated={alert.escalatedAt !== null || undefined}>
      <div className="alert-row__text">
        <p className="alert-row__title">{title}</p>
        {detail === null ? null : <p className="alert-row__detail">{detail}</p>}
        <p className="alert-row__meta">
          <span>{alertAge(alert.createdAt, now, t)}</span>
          {others.length > 0 ? <span>{t('alerts.for', { name: others.join(', ') })}</span> : null}
          {alert.repeatCount > 0 ? (
            <span>{t('alerts.reminded', { count: alert.repeatCount })}</span>
          ) : null}
          {alert.escalatedAt === null ? null : (
            <Badge tone="danger" icon={<Icon name="warning" />}>
              {t('alerts.centre.escalated')}
            </Badge>
          )}
        </p>
      </div>
      <Button
        variant="secondary"
        loading={working}
        aria-label={t('alerts.acknowledgeOf', { title })}
        onClick={() => {
          void acknowledge();
        }}
      >
        {t('alerts.acknowledge')}
      </Button>
    </div>
  );
}

/**
 * The header's alerts button: how many open alerts ask for the person, red when one was escalated
 * to them. Opens the alert centre over the screen.
 */
export function AlertsButton() {
  const state = useAlerts();
  const t = useT();
  if (state === null) return null;
  const open = state.alerts.status === 'ready' ? state.alerts.value : [];
  const mine = alertsForMe(open, state.person.id);
  const escalated = mine.some((alert) => alert.escalatedTo.includes(state.person.id));
  return (
    <Button
      variant="secondary"
      className="console-header__alerts"
      startIcon={<Icon name="bell" />}
      aria-label={t('alerts.centre.button', { count: mine.length })}
      onClick={() => {
        state.setPanel('alerts');
      }}
    >
      {t('alerts.title')}
      {mine.length === 0 ? null : (
        <Badge tone={escalated ? 'danger' : 'warning'} variant="solid">
          {mine.length}
        </Badge>
      )}
    </Button>
  );
}

/** The alert centre as a side sheet over any POS or manage screen, and the nudge dialog. */
export function AlertPanels() {
  const state = useAlerts();
  const t = useT();
  if (state === null) return null;
  const close = () => {
    state.setPanel(undefined);
  };
  return (
    <>
      {state.panel === 'alerts' ? (
        <Sheet open side="end" onClose={close} title={t('alerts.title')}>
          <AlertCentre />
        </Sheet>
      ) : null}
      {state.panel === 'nudge' ? <NudgeDialog onClose={close} /> : null}
    </>
  );
}
