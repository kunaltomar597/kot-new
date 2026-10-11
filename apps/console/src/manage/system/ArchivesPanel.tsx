import type { ArchivesResponse, DataExportView } from '@rp/contracts';
import { displayDateTime, formatDisplayDate } from '@rp/domain';
import { Badge, Button, Dialog, TextField, useToast } from '@rp/ui-web';
import { useCallback, useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { useConsole, useConsoleState } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { grantOf } from '../../app/modes.js';
import { SecondFactorCancelled, useSecondFactor } from '../../owner/second-factor.js';

/** While an archive is being made, look again this often. */
export const ARCHIVE_POLL_MS = 3_000;

const STATUS_TONE = {
  ARCHIVING: 'info',
  VERIFYING: 'info',
  PURGING: 'info',
  DONE: 'success',
  FAILED: 'danger',
} as const;

type Year = ArchivesResponse['years'][number];

/**
 * Archives one financial year (DATA-008): where to, the statutory warning to acknowledge while
 * GST law still asks for the records, and a reason; the Owner's second factor is asked.
 */
function ArchiveDialog({
  year,
  onClose,
  onStarted,
}: {
  year: Year;
  onClose: () => void;
  onStarted: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const { withSecondFactor, dialog } = useSecondFactor();
  const [folder, setFolder] = useState('');
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const ackId = useId();
  const understoodId = useId();
  const valid =
    reason.trim().length >= 3 && understood && (!year.withinStatutoryPeriod || acknowledged);
  return (
    <>
      <Dialog
        open
        onClose={onClose}
        dismissible={!busy}
        title={t('archives.dialog.title', { year: year.financialYear })}
        description={t('archives.dialog.intro', {
          from: formatDisplayDate(year.startDate),
          to: formatDisplayDate(year.endDate),
          invoices: year.invoices,
        })}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {t('archives.dialog.cancel')}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={busy || !valid}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                withSecondFactor(() =>
                  controller.api.startArchive({
                    body: {
                      financialYear: year.financialYear,
                      folder: folder.trim() === '' ? null : folder.trim(),
                      acknowledgeStatutory: acknowledged,
                      reason: reason.trim(),
                    },
                  }),
                ).then(
                  () => {
                    setBusy(false);
                    onStarted();
                  },
                  (failure: unknown) => {
                    setBusy(false);
                    if (!(failure instanceof SecondFactorCancelled)) {
                      setError(messageOf(failure, t));
                    }
                  },
                );
              }}
            >
              {t('archives.dialog.confirm')}
            </Button>
          </>
        }
      >
        <div className="console-form">
          {year.withinStatutoryPeriod ? (
            <p role="note" className="console-notice console-notice--warning">
              {t('archives.dialog.statutory', { until: formatDisplayDate(year.statutoryUntil) })}
            </p>
          ) : null}
          <TextField
            label={t('archives.dialog.folder')}
            hint={t('archives.dialog.folderHint')}
            value={folder}
            maxLength={260}
            onChange={(event) => {
              setFolder(event.target.value);
            }}
          />
          <TextField
            label={t('archives.dialog.reason')}
            hint={t('archives.dialog.reasonHint')}
            value={reason}
            maxLength={200}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
          {year.withinStatutoryPeriod ? (
            <label className="menu-toolbar__check" htmlFor={ackId}>
              <input
                id={ackId}
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => {
                  setAcknowledged(event.target.checked);
                }}
              />
              {t('archives.dialog.acknowledge', {
                until: formatDisplayDate(year.statutoryUntil),
              })}
            </label>
          ) : null}
          <label className="menu-toolbar__check" htmlFor={understoodId}>
            <input
              id={understoodId}
              type="checkbox"
              checked={understood}
              onChange={(event) => {
                setUnderstood(event.target.checked);
              }}
            />
            {t('archives.dialog.understood', { year: year.financialYear })}
          </label>
        </div>
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
      </Dialog>
      {dialog}
    </>
  );
}

/**
 * Old years on the System page (DATA-008, P7-06b), for the Owner: the whole financial years that
 * may be archived and removed from this PC, oldest first, and every archive made (the purge
 * records).
 */
export function ArchivesPanel() {
  const t = useT();
  const controller = useConsole();
  const { person } = useConsoleState();
  const toast = useToast();
  const owner = person !== undefined && grantOf(person, 'DATA_ADMIN') !== 'DENY';
  // DATA-009: those who read the restaurant's reports open archives (a cashier's are their own
  // shifts'); only the Owner archives.
  const reads = person !== undefined && grantOf(person, 'REPORTS_VIEW_EXPORT') === 'ALLOW';
  const [view, setView] = useState<ArchivesResponse | undefined>();
  const [failed, setFailed] = useState<string | undefined>();
  const [archiving, setArchiving] = useState<Year | undefined>();

  const load = useCallback(() => {
    controller.api.listArchives().then(
      (archives) => {
        setView(archives);
        setFailed(undefined);
      },
      (failure: unknown) => {
        setFailed(messageOf(failure, t));
      },
    );
  }, [controller, t]);
  useEffect(() => {
    if (reads) load();
  }, [reads, load]);
  const running = view?.running === true;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(load, ARCHIVE_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [running, load]);

  if (!reads) return null;
  const at = (iso: string) => t('backups.at', displayDateTime(new Date(iso)));
  return (
    <section className="device-group" aria-labelledby="system-archives">
      <h3 id="system-archives" className="device-group__heading">
        {t('archives.title')}
      </h3>
      <p className="dashboard-section__hint">{t('archives.intro')}</p>
      {failed === undefined ? null : (
        <p role="alert" className="console-notice console-notice--danger">
          {failed}
        </p>
      )}
      {view === undefined ? null : (
        <>
          {view.years.length === 0 ? (
            <p className="dashboard-section__hint">{t('archives.none')}</p>
          ) : (
            <ul className="staff-list" aria-label={t('archives.years')}>
              {view.years.map((year) => (
                <li key={year.financialYear} className="staff-row">
                  <div className="staff-row__who">
                    <h4 className="staff-row__name">
                      {t('archives.year', { year: year.financialYear })}
                    </h4>
                    <p className="staff-row__contact">
                      {t('archives.invoices', { count: year.invoices })}{' '}
                      {year.withinStatutoryPeriod
                        ? t('archives.keepUntil', {
                            until: formatDisplayDate(year.statutoryUntil),
                          })
                        : null}
                    </p>
                  </div>
                  {year.next && owner ? (
                    <div className="staff-row__actions">
                      <Button
                        variant="secondary"
                        disabled={running}
                        onClick={() => {
                          setArchiving(year);
                        }}
                      >
                        {t('archives.archive', { year: year.financialYear })}
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {view.runs.length === 0 ? null : (
            <table className="backups-table">
              <caption>{t('archives.made')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('archives.column.year')}</th>
                  <th scope="col">{t('archives.column.started')}</th>
                  <th scope="col">{t('archives.column.status')}</th>
                  <th scope="col">{t('archives.column.where')}</th>
                  <th scope="col">{t('archives.column.open')}</th>
                </tr>
              </thead>
              <tbody>
                {view.runs.map((run) => (
                  <tr key={run.id}>
                    <td>{run.financialYear}</td>
                    <td>{at(run.startedAt)}</td>
                    <td>
                      <Badge tone={STATUS_TONE[run.status]}>
                        {t(`archives.status.${run.status}`)}
                      </Badge>
                    </td>
                    <td className="backups__path">{run.error ?? run.folder ?? ''}</td>
                    <td>
                      {run.status === 'DONE' ? (
                        <Link
                          className="console-link"
                          to={`/manage/archives/${run.id}`}
                          aria-label={t('archives.openYear', { year: run.financialYear })}
                        >
                          {t('archives.open')}
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {archiving === undefined ? null : (
        <ArchiveDialog
          year={archiving}
          onClose={() => {
            setArchiving(undefined);
          }}
          onStarted={() => {
            setArchiving(undefined);
            toast.show({ title: t('archives.started'), tone: 'success' });
            load();
          }}
        />
      )}
      {owner ? <DataExport /> : null}
    </section>
  );
}

/**
 * The full data export (DATA-010, P7-06c): everything in open formats, into a folder, at any time,
 * also while the licence restricts ordering.
 */
function DataExport() {
  const t = useT();
  const controller = useConsole();
  const { withSecondFactor, dialog } = useSecondFactor();
  const [last, setLast] = useState<DataExportView | null | undefined>();
  const [asking, setAsking] = useState(false);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const load = useCallback(() => {
    controller.api.getDataExport().then(
      (answer) => {
        setLast(answer.last);
      },
      () => undefined,
    );
  }, [controller]);
  useEffect(load, [load]);
  const running = last?.status === 'RUNNING';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(load, ARCHIVE_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [running, load]);
  return (
    <div className="backups__owner">
      <p className="dashboard-section__hint">
        {last === undefined || last === null
          ? t('dataExport.intro')
          : t(`dataExport.status.${last.status}`, { folder: last.folder, error: last.error ?? '' })}
      </p>
      <Button
        variant="secondary"
        disabled={running}
        loading={running}
        onClick={() => {
          setAsking(true);
        }}
      >
        {t('dataExport.open')}
      </Button>
      {asking ? (
        <Dialog
          open
          onClose={() => {
            setAsking(false);
          }}
          dismissible={!busy}
          title={t('dataExport.title')}
          description={t('dataExport.description')}
          footer={
            <>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setAsking(false);
                }}
              >
                {t('archives.dialog.cancel')}
              </Button>
              <Button
                loading={busy}
                onClick={() => {
                  setBusy(true);
                  setError(undefined);
                  withSecondFactor(() =>
                    controller.api.startDataExport({
                      body: { folder: folder.trim() === '' ? null : folder.trim() },
                    }),
                  ).then(
                    (started) => {
                      setBusy(false);
                      setAsking(false);
                      setLast(started);
                    },
                    (failure: unknown) => {
                      setBusy(false);
                      if (!(failure instanceof SecondFactorCancelled)) {
                        setError(messageOf(failure, t));
                      }
                    },
                  );
                }}
              >
                {t('dataExport.confirm')}
              </Button>
            </>
          }
        >
          <TextField
            label={t('archives.dialog.folder')}
            hint={t('archives.dialog.folderHint')}
            value={folder}
            maxLength={260}
            onChange={(event) => {
              setFolder(event.target.value);
            }}
          />
          {error === undefined ? null : (
            <p role="alert" className="console-notice console-notice--danger">
              {error}
            </p>
          )}
        </Dialog>
      ) : null}
      {dialog}
    </div>
  );
}
