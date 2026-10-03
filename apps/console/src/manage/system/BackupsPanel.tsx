import type { BackupsResponse } from '@rp/contracts';
import { displayDateTime } from '@rp/domain';
import { Badge, Button, useToast } from '@rp/ui-web';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useConsole, useConsoleState } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { grantOf } from '../../app/modes.js';
import { RecoveryKeyButton, RestoreDialog } from './BackupRestore.js';
import { bytesParts } from './system-view.js';

/** While a backup runs, look again this often. */
export const BACKUP_POLL_MS = 3_000;

const HEALTH_TONE = {
  OK: 'success',
  FAILED: 'danger',
  OVERDUE: 'warning',
  NONE: 'warning',
} as const;
const STATUS_TONE = {
  RUNNING: 'info',
  SUCCEEDED: 'success',
  PARTIAL: 'warning',
  FAILED: 'danger',
} as const;

/**
 * Backups on the System page (DATA-002, DATA-005, P7-05a): how they stand, where they are kept,
 * the latest ones and "Back up now". A failure is also an alert for the Owner and managers. The
 * Owner restores from here and sees the recovery key (DATA-004, P7-05b).
 */
export function BackupsPanel() {
  const t = useT();
  const controller = useConsole();
  const { person } = useConsoleState();
  const toast = useToast();
  const [view, setView] = useState<BackupsResponse | undefined>();
  const [failed, setFailed] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restarting, setRestarting] = useState<string | undefined>();
  // DATA-004, AUTH-006: restore and the recovery key are the Owner's.
  const owner = person !== undefined && grantOf(person, 'DATA_ADMIN') !== 'DENY';

  const load = useCallback(() => {
    controller.api.listBackups().then(
      (backups) => {
        setView(backups);
        setFailed(undefined);
      },
      (failure: unknown) => {
        setFailed(messageOf(failure, t));
      },
    );
  }, [controller, t]);
  useEffect(load, [load]);
  const running = view?.running === true;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(load, BACKUP_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [running, load]);

  const size = (bytes: number) => {
    const { value, unit } = bytesParts(bytes);
    return t(`systemPage.bytes.${unit}`, { value });
  };
  const at = (iso: string) => t('backups.at', displayDateTime(new Date(iso)));

  return (
    <section className="device-group" aria-labelledby="system-backup">
      <h3 id="system-backup" className="device-group__heading">
        {t('systemPage.backup.title')}
      </h3>
      {failed === undefined ? null : (
        <p role="alert" className="console-notice console-notice--danger">
          {failed}
        </p>
      )}
      {view === undefined ? null : (
        <>
          <p className="staff-row__states">
            <Badge tone={HEALTH_TONE[view.health]}>{t(`backups.health.${view.health}`)}</Badge>
          </p>
          {restarting === undefined ? null : (
            <p role="status" className="console-notice console-notice--info">
              {t('backups.restore.restarting', { when: at(restarting) })}
            </p>
          )}
          {view.restorePending && restarting === undefined ? (
            <p className="console-notice console-notice--info">{t('backups.restore.pending')}</p>
          ) : null}
          {view.lastRestore === null ? null : view.lastRestore.ok ? (
            <p className="dashboard-section__hint">
              {view.lastRestore.backupCreatedAt === null
                ? t('backups.restore.doneAt', { at: at(view.lastRestore.at) })
                : t('backups.restore.done', {
                    at: at(view.lastRestore.at),
                    when: at(view.lastRestore.backupCreatedAt),
                  })}{' '}
              {view.lastRestore.previousDatabase === null
                ? null
                : t('backups.restore.kept', { name: view.lastRestore.previousDatabase })}
            </p>
          ) : (
            <p className="console-notice console-notice--danger">
              {t('backups.restore.failed', {
                at: at(view.lastRestore.at),
                error: view.lastRestore.error ?? '',
              })}
            </p>
          )}
          <p className="dashboard-section__hint">
            {view.lastSuccessAt === null
              ? t('systemPage.backup.never')
              : t('systemPage.backup.last', displayDateTime(new Date(view.lastSuccessAt)))}{' '}
            {t('backups.next', displayDateTime(new Date(view.nextNightlyAt)))}
          </p>
          <ul className="staff-list" aria-label={t('backups.locations')}>
            {view.locations.map((location) => (
              <li key={location.location} className="staff-row">
                <div className="staff-row__who">
                  <h4 className="staff-row__name">{t(`backups.location.${location.location}`)}</h4>
                  {location.path === null ? (
                    <p className="staff-row__contact">
                      {t('backups.secondNotSet')}{' '}
                      <Link className="console-link" to="/manage/settings">
                        {t('backups.openSettings')}
                      </Link>
                    </p>
                  ) : (
                    <>
                      <p className="staff-row__contact backups__path">{location.path}</p>
                      <p className="staff-row__contact">
                        {location.available
                          ? t('backups.kept', { count: location.files.length })
                          : t('backups.unavailable')}
                      </p>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <Button
            variant="secondary"
            loading={busy || running}
            disabled={busy || running}
            onClick={() => {
              setBusy(true);
              controller.api.startBackup().then(
                () => {
                  setBusy(false);
                  toast.show({ title: t('backups.started'), tone: 'success' });
                  load();
                },
                (failure: unknown) => {
                  setBusy(false);
                  toast.show({ title: messageOf(failure, t), tone: 'danger' });
                },
              );
            }}
          >
            {running ? t('backups.running') : t('backups.now')}
          </Button>
          {owner ? (
            <div className="backups__owner">
              <Button
                variant="ghost"
                disabled={running || view.restorePending || restarting !== undefined}
                onClick={() => {
                  setRestoring(true);
                }}
              >
                {t('backups.restore.open')}
              </Button>
              <RecoveryKeyButton />
            </div>
          ) : null}
          {restoring ? (
            <RestoreDialog
              view={view}
              onClose={() => {
                setRestoring(false);
              }}
              onRequested={(backupCreatedAt) => {
                setRestoring(false);
                setRestarting(backupCreatedAt);
              }}
            />
          ) : null}
          {view.runs.length === 0 ? null : (
            <table className="backups-table">
              <caption>{t('backups.latest')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('backups.column.when')}</th>
                  <th scope="col">{t('backups.column.kind')}</th>
                  <th scope="col">{t('backups.column.status')}</th>
                  <th scope="col">{t('backups.column.size')}</th>
                  <th scope="col">{t('backups.column.notes')}</th>
                </tr>
              </thead>
              <tbody>
                {view.runs.map((run) => (
                  <tr key={run.id}>
                    <td>{at(run.startedAt)}</td>
                    <td>
                      {run.requestedBy === null
                        ? t(`backups.kind.${run.kind}`)
                        : t('backups.kindBy', {
                            kind: t(`backups.kind.${run.kind}`),
                            name: run.requestedBy,
                          })}
                    </td>
                    <td>
                      <Badge tone={STATUS_TONE[run.status]}>
                        {t(`backups.status.${run.status}`)}
                      </Badge>
                    </td>
                    <td>{run.sizeBytes === null ? '' : size(run.sizeBytes)}</td>
                    <td>
                      {run.error ??
                        (run.secondCopy === 'COPIED'
                          ? t('backups.copied')
                          : run.secondCopy === 'NOT_SET'
                            ? t('backups.notCopied')
                            : '')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
