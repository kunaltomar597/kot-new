import type { OfferedUpdate, SystemView } from '@rp/contracts';
import type { Tone } from '@rp/design-tokens';
import { grantOf, timeOfDayOf } from '@rp/domain';
import { sizeText } from '@rp/ordering';
import { Badge, Button, ErrorState, LoadingState, useToast } from '@rp/ui-web';
import { Fragment, type ReactNode, useEffect, useState } from 'react';
import { useConsole, useConsoleState } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { InstallNowDialog } from './InstallNowDialog.js';
import {
  approvalText,
  categorySize,
  deviceLines,
  driveText,
  installChoiceOf,
  momentText,
  type ServiceHealth,
  serviceLines,
  STORAGE_CATEGORY_KEYS,
  uptimeText,
} from './system-view.js';

/**
 * Connections, database latency and the drive are not announced, so the page reads them again
 * this often; table, device, printer and settings changes are read again as they happen.
 */
export const SYSTEM_REFRESH_MS = 60_000;

const AFFECTED_BY = new Set([
  'TableOpened',
  'TableClosed',
  'TableStateChanged',
  'DeviceStatusChanged',
  'DeviceRevoked',
  'PrinterStatusChanged',
  'RestaurantChanged',
]);

const HEALTH_TONE: Readonly<Record<ServiceHealth, Tone>> = {
  ok: 'success',
  problem: 'danger',
  off: 'neutral',
};

const LEVEL_TONE: Readonly<Record<NonNullable<SystemView['storage']['level']>, Tone>> = {
  OK: 'success',
  WARNING: 'warning',
  CRITICAL: 'danger',
};

const LICENCE_TONE: Readonly<Record<NonNullable<SystemView['licence']>['state'], Tone>> = {
  ACTIVE: 'success',
  PAYMENT_DUE: 'warning',
  GRACE: 'warning',
  RESTRICTED: 'danger',
  TERMINATED: 'danger',
};

/**
 * The System page (P4-04b, MGR-010, NFR-I03): the one screen support asks about. Versions and
 * whether the database, the pager link, the printers and the support link work; connected
 * devices by type; the data drive against the warning levels and by category (DATA-006); how
 * backups are set up; the licence (LIC-008); and updates with "Install now" (UPD-004). "Send
 * diagnostics to support" (UPD-008) sends the health report now.
 */
export function SystemScreen() {
  const t = useT();
  const controller = useConsole();
  const { person } = useConsoleState();
  const toast = useToast();
  const { data, reload } = useLive(
    () => controller.api.getSystem(),
    (type) => AFFECTED_BY.has(type),
  );
  useEffect(() => {
    const timer = setInterval(reload, SYSTEM_REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [reload]);
  // The release the manager pressed "Install now" for: the dialog approves that one.
  const [installing, setInstalling] = useState<OfferedUpdate | null>(null);
  const [sending, setSending] = useState(false);
  const canInstall = person !== undefined && grantOf(person, 'UPDATE_INSTALL_NOW') === 'ALLOW';

  const send = async () => {
    setSending(true);
    try {
      const { sentAt } = await controller.api.sendDiagnostics();
      toast.show({
        title: t('system.diagnostics.sent', { time: timeOfDayOf(new Date(sentAt)) }),
        tone: 'success',
      });
    } catch (failure) {
      toast.show({ title: messageOf(failure, t), tone: 'danger' });
    } finally {
      setSending(false);
      reload();
    }
  };

  let content: ReactNode;
  let dialog: ReactNode = null;
  let linked = false;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('system.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const view = data.value;
    const { controlPlane } = view.services;
    linked = controlPlane.configured && controlPlane.enrolled;
    const choice = installChoiceOf(view.updates);
    content = (
      <SystemDetails
        view={view}
        now={new Date()}
        installAction={
          canInstall && (choice.kind === 'INSTALL' || choice.kind === 'WAIT_FOR_TABLES') ? (
            <Button
              disabled={choice.kind === 'WAIT_FOR_TABLES'}
              onClick={() => {
                setInstalling(view.updates.offered);
              }}
            >
              {t('system.updates.installNow')}
            </Button>
          ) : null
        }
      />
    );
    if (installing !== null) {
      // Tables open or close while the dialog is up: the reason follows them, and the server
      // checks again.
      dialog = (
        <InstallNowDialog
          offered={installing}
          needsReason={installing.securityCritical && view.updates.openTables > 0}
          onClose={() => {
            setInstalling(null);
          }}
          onApproved={() => {
            setInstalling(null);
            reload();
          }}
        />
      );
    }
  }

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-system">
      <div className="staff-header">
        <h2 id="dashboard-system" className="dashboard-section__heading">
          {t('system.title')}
        </h2>
        <Button
          variant="secondary"
          loading={sending}
          disabled={!linked}
          onClick={() => {
            void send();
          }}
        >
          {t('system.diagnostics.send')}
        </Button>
      </div>
      <p className="dashboard-section__hint">{t('system.intro')}</p>
      {content}
      {dialog}
    </section>
  );
}

function SystemDetails({
  view,
  now,
  installAction,
}: {
  view: SystemView;
  now: Date;
  installAction: ReactNode;
}) {
  const t = useT();
  const { versions, storage, backups, licence, updates } = view;
  const devices = deviceLines(view.devices);
  const choice = installChoiceOf(updates);
  return (
    <>
      <Part id="system-versions" title={t('system.versions.title')}>
        <dl className="settings-facts">
          <dt>{t('system.versions.product')}</dt>
          <dd>{versions.product}</dd>
          <dt>{t('system.versions.server')}</dt>
          <dd>{versions.server}</dd>
          <dt>{t('system.versions.node')}</dt>
          <dd>{versions.node}</dd>
          <dt>{t('system.versions.postgres')}</dt>
          <dd>{versions.postgres ?? t('system.versions.unknown')}</dd>
          {versions.buildId === null ? null : (
            <>
              <dt>{t('system.versions.build')}</dt>
              <dd>{versions.buildId}</dd>
            </>
          )}
        </dl>
        <p className="dashboard-section__hint">{uptimeText(view.uptimeSeconds, t)}</p>
      </Part>

      <Part id="system-services" title={t('system.services.title')}>
        <dl className="settings-facts">
          {serviceLines(view, now, t).map((line) => (
            <Fragment key={line.key}>
              <dt>{line.name}</dt>
              <dd className="system-fact">
                <Badge tone={HEALTH_TONE[line.health]}>{t(`system.status.${line.health}`)}</Badge>
                <span>{line.detail}</span>
              </dd>
            </Fragment>
          ))}
        </dl>
      </Part>

      <Part id="system-devices" title={t('system.devices.title')}>
        {devices.length === 0 ? (
          <p className="dashboard-section__hint">{t('system.devices.none')}</p>
        ) : (
          <dl className="settings-facts">
            {devices.map((group) => (
              <Fragment key={group.type}>
                <dt>{t(`devices.group.${group.type}`)}</dt>
                <dd>
                  {t('system.devices.count', {
                    connected: group.connected,
                    paired: group.paired,
                  })}
                </dd>
              </Fragment>
            ))}
          </dl>
        )}
      </Part>

      <Part id="system-storage" title={t('system.storage.title')}>
        <p className="system-fact">
          {storage.level === null ? null : (
            <Badge tone={LEVEL_TONE[storage.level]}>
              {t(`system.storage.level.${storage.level}`)}
            </Badge>
          )}
          <span>{driveText(storage, t)}</span>
        </p>
        {storage.usedPercent === null ? null : (
          <meter
            className="system-meter"
            aria-label={t('system.storage.meter')}
            min={0}
            max={100}
            low={storage.warnPercent}
            high={storage.criticalPercent}
            optimum={0}
            value={storage.usedPercent}
          />
        )}
        <p className="dashboard-section__hint">
          {t('system.storage.levels', {
            warn: storage.warnPercent,
            critical: storage.criticalPercent,
          })}
        </p>
        <h4 className="system-subheading">{t('system.storage.byCategory')}</h4>
        <dl className="settings-facts">
          {storage.categories.map((entry) => (
            <Fragment key={entry.category}>
              <dt>{t(STORAGE_CATEGORY_KEYS[entry.category])}</dt>
              <dd>{categorySize(entry.bytes, t)}</dd>
            </Fragment>
          ))}
        </dl>
      </Part>

      <Part id="system-backups" title={t('system.backups.title')}>
        <p>
          {backups.lastBackupAt === null
            ? t('system.backups.never')
            : momentText(backups.lastBackupAt, now, t, {
                today: 'system.backups.lastToday',
                earlier: 'system.backups.lastEarlier',
              })}
        </p>
        <dl className="settings-facts">
          <dt>{t('system.backups.log')}</dt>
          <dd>{t(`system.backups.walMode.${backups.walMode}`)}</dd>
          <dt>{t('system.backups.nightly')}</dt>
          <dd>
            {backups.secondLocation === null
              ? t('system.backups.noSecondLocation')
              : t('system.backups.secondLocation', { folder: backups.secondLocation })}
          </dd>
          <dt>{t('system.backups.kept')}</dt>
          <dd>
            {t('system.backups.keptCount', {
              daily: backups.keepDaily,
              weekly: backups.keepWeekly,
            })}
          </dd>
          <dt>{t('system.backups.cloud')}</dt>
          <dd>
            {backups.cloudEnabled ? t('system.backups.cloudOn') : t('system.backups.cloudOff')}
          </dd>
        </dl>
        <p className="dashboard-section__hint">{t('system.backups.ownerChanges')}</p>
      </Part>

      <Part id="system-licence" title={t('system.licence.title')}>
        {licence === null ? (
          <p>{t('system.licence.none')}</p>
        ) : (
          <p className="system-fact">
            <Badge tone={LICENCE_TONE[licence.state]}>
              {t(`system.licence.state.${licence.state}`)}
            </Badge>
            {licence.daysLeft === null ? null : (
              <span>{t('system.licence.daysLeft', { days: licence.daysLeft })}</span>
            )}
          </p>
        )}
      </Part>

      <Part id="system-updates" title={t('system.updates.title')} action={installAction}>
        <dl className="settings-facts">
          <dt>{t('system.updates.installed')}</dt>
          <dd>{t('system.updates.version', { version: updates.current })}</dd>
          {updates.channel === null ? null : (
            <>
              <dt>{t('system.updates.channelLabel')}</dt>
              <dd>{t(`system.updates.channel.${updates.channel}`)}</dd>
            </>
          )}
        </dl>
        {updates.offered === null ? (
          <p>{t('system.updates.upToDate')}</p>
        ) : (
          <>
            <p className="system-fact">
              {updates.offered.securityCritical ? (
                <Badge tone="warning">{t('system.updates.security')}</Badge>
              ) : null}
              <span>
                {t('system.updates.offered', {
                  version: updates.offered.version,
                  size: sizeText(updates.offered.sizeBytes, t),
                })}
              </span>
            </p>
            {updates.offered.notes === null ? null : (
              <p>{t('system.updates.notes', { notes: updates.offered.notes })}</p>
            )}
            {updates.approval === null ? null : <p>{approvalText(updates.approval, now, t)}</p>}
            {choice.kind === 'WAIT_FOR_TABLES' ? (
              <p>{t('system.updates.openTables', { count: updates.openTables })}</p>
            ) : null}
            {choice.kind === 'INSTALL' && choice.needsReason ? (
              <p>{t('system.updates.openTablesSecurity', { count: updates.openTables })}</p>
            ) : null}
          </>
        )}
        <p className="dashboard-section__hint">
          {t('system.updates.window', {
            start: updates.maintenanceWindow.start,
            end: updates.maintenanceWindow.end,
          })}
        </p>
      </Part>
    </>
  );
}

function Part({
  id,
  title,
  action,
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-group" aria-labelledby={id}>
      <div className="staff-header">
        <h3 id={id} className="settings-group__heading">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}
