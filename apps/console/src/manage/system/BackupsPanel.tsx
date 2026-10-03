import type { BackupsResponse } from '@rp/contracts';
import { displayDateTime } from '@rp/domain';
import { Badge, Button, useToast } from '@rp/ui-web';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
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
 * the latest ones and "Back up now". A failure is also an alert for the Owner and managers.
 */
export function BackupsPanel() {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const [view, setView] = useState<BackupsResponse | undefined>();
  const [failed, setFailed] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

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
