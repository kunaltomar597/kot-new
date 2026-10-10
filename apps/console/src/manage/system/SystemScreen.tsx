import type { SystemStatusResponse } from '@rp/contracts';
import { displayDateTime } from '@rp/domain';
import {
  Badge,
  Button,
  ConfirmDialog,
  ErrorState,
  LoadingState,
  TextField,
  useToast,
} from '@rp/ui-web';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useConsole, useConsoleState } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { grantOf } from '../../app/modes.js';
import { useLive } from '../../app/use-live.js';
import { ArchivesPanel } from './ArchivesPanel.js';
import { BackupsPanel } from './BackupsPanel.js';
import { DiagnosticsPanel } from './DiagnosticsPanel.js';
import { UninstallPanel } from './UninstallPanel.js';
import { bytesParts, uptimeParts } from './system-view.js';

/** Disk, connections and the vendor link are not announced, so read them again. */
export const SYSTEM_REFRESH_MS = 30_000;

type Translate = ReturnType<typeof useT>;

const LEVEL_TONE = {
  OK: 'success',
  WARNING: 'warning',
  CRITICAL: 'danger',
  UNKNOWN: 'neutral',
} as const;

function bytesText(bytes: number, t: Translate): string {
  const { value, unit } = bytesParts(bytes);
  return t(`systemPage.bytes.${unit}`, { value });
}

function uptimeText(seconds: number, t: Translate): string {
  const parts = uptimeParts(seconds);
  return parts.kind === 'days'
    ? t('systemPage.uptime.days', { days: parts.days, hours: parts.hours })
    : parts.kind === 'hours'
      ? t('systemPage.uptime.hours', { hours: parts.hours, minutes: parts.minutes })
      : t('systemPage.uptime.minutes', { minutes: parts.minutes });
}

function vendorText(controlPlane: SystemStatusResponse['controlPlane'], t: Translate): string {
  if (!controlPlane.configured) return t('systemPage.services.vendorOff');
  if (!controlPlane.enrolled) return t('systemPage.services.vendorNotEnrolled');
  if (controlPlane.lastError !== null) {
    return t('systemPage.services.vendorError', { code: controlPlane.lastError });
  }
  return controlPlane.lastContactAt === null
    ? t('systemPage.services.vendorNever')
    : t('systemPage.services.vendorOk', displayDateTime(new Date(controlPlane.lastContactAt)));
}

function relayText(relay: SystemStatusResponse['qrRelay'], t: Translate): string {
  if (!relay.configured) return t('systemPage.services.qrRelayOff');
  if (!relay.credential) return t('systemPage.services.qrRelayNoCredential');
  if (relay.lastError !== null)
    return t('systemPage.services.qrRelayError', { code: relay.lastError });
  if (relay.lastContactAt === null) return t('systemPage.services.qrRelayNever');
  const inStep = t('systemPage.services.qrRelayOk', {
    version: relay.menuVersion ?? 0,
    ...displayDateTime(new Date(relay.lastContactAt)),
  });
  // P5-03d: how new QR orders reach this PC.
  return `${inStep}. ${t(relay.realtime ? 'systemPage.services.qrRelayRealtime' : 'systemPage.services.qrRelayPolling')}`;
}

type UpdateStatus = SystemStatusResponse['update'];

/** What the update agent is doing (P7-04c), or null when there is nothing to say. */
function agentLine(agent: UpdateStatus['agent'], t: Translate): ReactNode {
  const version = agent.version ?? '';
  const retry = agent.retryAt === null ? '' : displayDateTime(new Date(agent.retryAt)).time;
  switch (agent.state) {
    case 'DOWNLOADING':
      return (
        <p className="dashboard-section__hint">
          {t('systemPage.update.agent.DOWNLOADING', { version })}
        </p>
      );
    case 'DOWNLOAD_FAILED':
    case 'PREPARE_FAILED':
      return (
        <p className="console-notice">
          {t(`systemPage.update.agent.${agent.state}`, { error: agent.error ?? '', time: retry })}
        </p>
      );
    case 'WAITING':
      return agent.waitingFor === 'RETRY_APPROVAL' ? (
        <p className="console-notice">{t('systemPage.update.agent.RETRY_APPROVAL')}</p>
      ) : (
        <p className="dashboard-section__hint">{t('systemPage.update.agent.READY')}</p>
      );
    case 'PREPARING':
      return <p className="dashboard-section__hint">{t('systemPage.update.agent.PREPARING')}</p>;
    case 'INSTALLING':
      return (
        <p className="console-notice" role="status">
          {t('systemPage.update.agent.INSTALLING', { version })}
        </p>
      );
    case 'UNAVAILABLE':
      return <p className="console-notice">{agent.error}</p>;
    case 'IDLE':
      return null;
  }
}

/**
 * The apps to update (UPD-006): the ones the server no longer serves, the ones it serves until its
 * next update, and the ones newer than the PC.
 */
function ClientLines({
  counts,
  t,
}: {
  counts: SystemStatusResponse['clients']['counts'];
  t: Translate;
}) {
  const count = (compatibility: string) =>
    counts.find((entry) => entry.compatibility === compatibility)?.devices ?? 0;
  const [tooOld, previous, newer] = [count('TOO_OLD'), count('PREVIOUS'), count('NEWER')];
  return (
    <>
      {tooOld > 0 ? (
        <p className="console-notice">{t('systemPage.devices.tooOld', { count: tooOld })}</p>
      ) : null}
      {previous > 0 ? (
        <p className="dashboard-section__hint">
          {t('systemPage.devices.previous', { count: previous })}
        </p>
      ) : null}
      {newer > 0 ? (
        <p className="dashboard-section__hint">{t('systemPage.devices.newer', { count: newer })}</p>
      ) : null}
    </>
  );
}

/**
 * The phone and tablet builds this PC serves from its release (P7-04e2, WTR-001): what devices
 * update to, or why one is not offered.
 */
function BuildLines({
  builds,
  t,
}: {
  builds: SystemStatusResponse['clients']['builds'];
  t: Translate;
}) {
  if (builds.length === 0) return null;
  return (
    <>
      <p className="dashboard-section__hint">{t('systemPage.devices.builds.intro')}</p>
      <Facts
        facts={builds.map(
          (build) =>
            [
              t(`systemPage.devices.builds.kind.${build.kind}`),
              build.status === 'OK' ? (
                t('systemPage.devices.builds.OK', {
                  version: build.version,
                  size: bytesText(build.sizeBytes, t),
                })
              ) : (
                <span className="console-notice">
                  {t(`systemPage.devices.builds.${build.status}`, { version: build.version })}
                </span>
              ),
            ] as const,
        )}
      />
    </>
  );
}

/** How the last update went (UPD-005): installed, rolled back with the backup, or not installed. */
function OutcomeLines({
  outcome,
  t,
}: {
  outcome: NonNullable<UpdateStatus['agent']['lastOutcome']>;
  t: Translate;
}) {
  const when = displayDateTime(new Date(outcome.at));
  if (outcome.outcome === 'INSTALLED') {
    return (
      <p className="dashboard-section__hint">
        {t('systemPage.update.outcome.INSTALLED', { version: outcome.version, ...when })}
      </p>
    );
  }
  return (
    <>
      <p className="console-notice">
        {t(`systemPage.update.outcome.${outcome.outcome}`, {
          version: outcome.version,
          previous: outcome.previousVersion ?? '',
          error: outcome.error ?? '',
          ...when,
        })}
      </p>
      {outcome.backupFileName === null ? null : (
        <p className="dashboard-section__hint">
          {t('systemPage.update.outcome.backup', { file: outcome.backupFileName })}
        </p>
      )}
    </>
  );
}

function Facts({ facts }: { facts: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="restaurant-facts">
      {facts.map(([term, value]) => (
        <div key={term} className="restaurant-facts__row">
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The System page (P4-04, MGR-010, NFR-I03, DATA-006): the services, the data drive by kind of
 * data with its warning levels, the devices connected, the update on offer with "Install now"
 * (UPD-004), backups, the licence, the versions, "Send diagnostics to support" (UPD-008) and
 * the Owner's permission for the uninstaller to delete the data (NFR-I02).
 * Backups have their own panel (P7-05a). Read again every half minute.
 */
export function SystemScreen() {
  const t = useT();
  const controller = useConsole();
  const { person } = useConsoleState();
  const toast = useToast();
  const canInstall = person !== undefined && grantOf(person, 'UPDATE_INSTALL_NOW') !== 'DENY';
  const { data, reload } = useLive(
    () => controller.api.getSystemStatus(),
    (type) => type === 'DeviceStatusChanged',
  );
  useEffect(() => {
    const timer = setInterval(reload, SYSTEM_REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [reload]);
  const [confirming, setConfirming] = useState<string | undefined>();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const close = useCallback(() => {
    setConfirming(undefined);
    setReason('');
    setBusy(false);
    setError(undefined);
  }, []);

  const approve = async (version: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await controller.api.approveUpdateInstall({
        body: { version, ...(reason.trim().length >= 3 && { reason: reason.trim() }) },
      });
      toast.show({ title: t('systemPage.update.done', { version }), tone: 'success' });
      close();
      reload();
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  let content: ReactNode;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('systemPage.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const system = data.value;
    const { storage, update } = system;
    const offered = update.offered;
    content = (
      <>
        <section className="device-group" aria-labelledby="system-services">
          <h3 id="system-services" className="device-group__heading">
            {t('systemPage.services.title')}
          </h3>
          <Facts
            facts={[
              [
                t('systemPage.services.database'),
                system.database.status === 'up'
                  ? t('systemPage.services.databaseUp', { latency: system.database.latencyMs })
                  : t('systemPage.services.databaseDown'),
              ],
              [t('systemPage.services.uptime'), uptimeText(system.uptimeSeconds, t)],
              [t('systemPage.services.vendor'), vendorText(system.controlPlane, t)],
              [t('systemPage.services.qrRelay'), relayText(system.qrRelay, t)],
            ]}
          />
        </section>

        <section className="device-group" aria-labelledby="system-storage">
          <div className="staff-header">
            <h3 id="system-storage" className="device-group__heading">
              {t('systemPage.storage.title')}
            </h3>
            <Badge tone={LEVEL_TONE[storage.level]}>
              {t(`systemPage.storage.level.${storage.level}`)}
            </Badge>
          </div>
          {storage.usedPercent === null ||
          storage.totalBytes === null ||
          storage.freeBytes === null ? (
            <p className="dashboard-section__hint">{t('systemPage.storage.unknown')}</p>
          ) : (
            <>
              <p className="settings-row__value">
                {t('systemPage.storage.used', {
                  percent: storage.usedPercent,
                  free: bytesText(storage.freeBytes, t),
                  total: bytesText(storage.totalBytes, t),
                })}
              </p>
              <meter
                className="system-meter"
                aria-label={t('systemPage.storage.title')}
                min={0}
                max={100}
                low={storage.warnPercent}
                high={storage.criticalPercent}
                optimum={0}
                value={storage.usedPercent}
              />
            </>
          )}
          {storage.encryption === 'NOT_ENCRYPTED' ? (
            <p role="alert" className="console-notice console-notice--danger">
              {t('systemPage.storage.notEncrypted')}
            </p>
          ) : null}
          {storage.level === 'WARNING' || storage.level === 'CRITICAL' ? (
            <p
              role="alert"
              className={`console-notice${storage.level === 'CRITICAL' ? ' console-notice--danger' : ''}`}
            >
              {storage.level === 'CRITICAL'
                ? t('systemPage.storage.critical', { percent: storage.criticalPercent })
                : t('systemPage.storage.warning', { percent: storage.warnPercent })}
            </p>
          ) : null}
          <Facts
            facts={storage.categories.map(
              (entry) =>
                [
                  t(`systemPage.storage.category.${entry.category}`),
                  entry.bytes === null
                    ? t('systemPage.storage.notMeasured')
                    : bytesText(entry.bytes, t),
                ] as const,
            )}
          />
          {/* DATA-007, BRD §9.3: what is removed by itself, and when it last ran (P7-06a). */}
          <p className="dashboard-section__hint">
            {t('systemPage.storage.retention', {
              days: storage.retention.operationalDays,
              months: storage.retention.dinerContactMonths,
            })}{' '}
            {storage.retention.lastRunAt === null
              ? null
              : t('systemPage.storage.retentionRun', {
                  when: t('backups.at', displayDateTime(new Date(storage.retention.lastRunAt))),
                  count: storage.retention.lastRunTotal ?? 0,
                })}
          </p>
        </section>

        <section className="device-group" aria-labelledby="system-devices">
          <h3 id="system-devices" className="device-group__heading">
            {t('systemPage.devices.title')}
          </h3>
          {system.devices.length === 0 ? (
            <p className="dashboard-section__hint">{t('systemPage.devices.none')}</p>
          ) : (
            <Facts
              facts={system.devices.map(
                (entry) =>
                  [
                    t(`devices.type.${entry.type}`),
                    t('systemPage.devices.line', {
                      connected: entry.connected,
                      paired: entry.paired,
                    }),
                  ] as const,
              )}
            />
          )}
          <ClientLines counts={system.clients.counts} t={t} />
          <BuildLines builds={system.clients.builds} t={t} />
        </section>

        <section className="device-group" aria-labelledby="system-update">
          <h3 id="system-update" className="device-group__heading">
            {t('systemPage.update.title')}
          </h3>
          {update.agent.lastOutcome === null ? null : (
            <OutcomeLines outcome={update.agent.lastOutcome} t={t} />
          )}
          {offered === null ? (
            <p className="dashboard-section__hint">{t('systemPage.update.upToDate')}</p>
          ) : (
            <>
              <p className="settings-row__value">
                {t('systemPage.update.offered', { version: offered.version })}
              </p>
              <p className="dashboard-section__hint">
                {t('systemPage.update.details', {
                  channel: offered.channel,
                  size: bytesText(offered.sizeBytes, t),
                  date: displayDateTime(new Date(offered.publishedAt)).date,
                })}
              </p>
              {offered.notes === null ? null : (
                <p className="dashboard-section__hint">{offered.notes}</p>
              )}
              {offered.leavesBehind !== null && offered.leavesBehind > 0 ? (
                <p className="console-notice">
                  {t('systemPage.update.leavesBehind', { count: offered.leavesBehind })}
                </p>
              ) : null}
              <p className="dashboard-section__hint">
                {t('systemPage.update.window', update.maintenanceWindow)}
              </p>
              {agentLine(update.agent, t)}
              {update.openTables > 0 && update.agent.state !== 'INSTALLING' ? (
                <p className="console-notice">
                  {t('systemPage.update.openTables', { count: update.openTables })}
                </p>
              ) : null}
              {update.agent.state === 'INSTALLING' ? null : update.installApproval === null ||
                update.agent.waitingFor === 'RETRY_APPROVAL' ? (
                canInstall ? (
                  <div className="staff-row__actions">
                    <Button
                      onClick={() => {
                        setConfirming(offered.version);
                      }}
                    >
                      {t('systemPage.update.installNow')}
                    </Button>
                  </div>
                ) : null
              ) : (
                <p className="console-notice">
                  {t('systemPage.update.approved', {
                    name: update.installApproval.approvedBy ?? t('systemPage.update.approvedBy'),
                    ...displayDateTime(new Date(update.installApproval.approvedAt)),
                  })}
                </p>
              )}
            </>
          )}
        </section>

        <BackupsPanel />

        <ArchivesPanel />

        <section className="device-group" aria-labelledby="system-licence">
          <h3 id="system-licence" className="device-group__heading">
            {t('systemPage.licence.title')}
          </h3>
          <p className="dashboard-section__hint">
            {system.licence === null ? t('systemPage.licence.notActive') : system.licence.state}
          </p>
        </section>

        <section className="device-group" aria-labelledby="system-versions">
          <h3 id="system-versions" className="device-group__heading">
            {t('systemPage.versions.title')}
          </h3>
          <Facts
            facts={[
              ...system.versions.map((entry) => [entry.name, entry.version] as const),
              [
                t('systemPage.versions.clientApi'),
                system.clients.api.oldest === system.clients.api.current
                  ? t('systemPage.versions.clientApiOnly', system.clients.api)
                  : t('systemPage.versions.clientApiValue', system.clients.api),
              ] as const,
            ]}
          />
        </section>

        <DiagnosticsPanel connected={system.controlPlane.enrolled} />

        <UninstallPanel allowedUntil={system.dataDeletionAllowedUntil} onAllowed={reload} />
      </>
    );
  }

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-system">
      <div className="staff-header">
        <h2 id="dashboard-system" className="dashboard-section__heading">
          {t('systemPage.title')}
        </h2>
        <Button variant="ghost" onClick={reload}>
          {t('systemPage.refresh')}
        </Button>
      </div>
      <p className="dashboard-section__hint">{t('systemPage.intro')}</p>
      {data.status === 'ready' ? (
        <p className="dashboard-section__hint">
          {t('systemPage.checkedAt', {
            time: displayDateTime(new Date(data.value.checkedAt)).time,
          })}
        </p>
      ) : null}
      {content}
      {confirming === undefined ? null : (
        <ConfirmDialog
          open
          tone="primary"
          title={t('systemPage.update.confirmTitle', { version: confirming })}
          description={t('systemPage.update.confirmDescription')}
          confirmLabel={t('systemPage.update.installNow')}
          cancelLabel={t('restaurantPage.cancel')}
          busy={busy}
          onConfirm={() => {
            void approve(confirming);
          }}
          onCancel={close}
        >
          <TextField
            label={t('restaurantPage.reason')}
            hint={t('restaurantPage.reasonHint')}
            value={reason}
            maxLength={200}
            autoComplete="off"
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
          {error === undefined ? null : (
            <p role="alert" className="console-notice console-notice--danger">
              {error}
            </p>
          )}
        </ConfirmDialog>
      )}
    </section>
  );
}
