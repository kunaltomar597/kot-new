import type {
  BackupLocation,
  BackupsResponse,
  RecoveryKeyResponse,
  RestoreBackupRequest,
} from '@rp/contracts';
import {
  calendarDateOf,
  DEFAULT_TIME_ZONE,
  displayDateTime,
  timeOfDayOf,
  zonedTimeToUtc,
} from '@rp/domain';
import { Button, Dialog, Select, TextField } from '@rp/ui-web';
import { useId, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { SecondFactorCancelled, useSecondFactor } from '../../owner/second-factor.js';

interface Choice {
  readonly value: string;
  readonly location: BackupLocation;
  readonly fileName: string;
  readonly takenAt: string;
}

/** Every backup the Owner may restore, newest first, from both places. */
export function restoreChoices(view: BackupsResponse): Choice[] {
  return view.locations
    .filter((location) => location.available)
    .flatMap((location) =>
      location.files.map((file) => ({
        value: `${location.location}/${file.name}`,
        location: location.location,
        fileName: file.name,
        takenAt: file.takenAt,
      })),
    )
    .sort((a, b) => b.takenAt.localeCompare(a.takenAt) || a.value.localeCompare(b.value));
}

/** The continuous backup's choices, offered first when there is a base backup (P7-05c). */
const LATEST = 'LATEST';
const MOMENT = 'MOMENT';

/** A `datetime-local` value (India time) as an instant; null when it is not one. */
export function momentOf(value: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  try {
    return zonedTimeToUtc(match[1], match[2], DEFAULT_TIME_ZONE);
  } catch {
    return null;
  }
}

/** An instant as a `datetime-local` value in India time. */
export function inputOf(date: Date): string {
  return `${calendarDateOf(date, DEFAULT_TIME_ZONE)}T${timeOfDayOf(date, DEFAULT_TIME_ZONE)}`;
}

/**
 * Restore this PC (DATA-004, P7-05b, P7-05c): to the latest moment or a moment of the Owner's
 * choosing from the continuous backup, or from one of the nightly backups. The Owner gives a
 * reason and confirms that everything after it is lost; the server restarts to do it.
 */
export function RestoreDialog({
  view,
  onClose,
  onRequested,
}: {
  view: BackupsResponse;
  onClose: () => void;
  /** What the restaurant goes back to, as people read it. */
  onRequested: (when: string) => void;
}) {
  const t = useT();
  const controller = useConsole();
  const { withSecondFactor, dialog } = useSecondFactor();
  const choices = restoreChoices(view);
  const { continuous } = view;
  const pointInTime = continuous.restorableFrom !== null;
  const [chosen, setChosen] = useState(pointInTime ? LATEST : (choices[0]?.value ?? ''));
  // The dialog's clock: read once when it opens.
  const [openedAt] = useState(() => Date.now());
  const [momentText, setMomentText] = useState(() => inputOf(new Date(openedAt)));
  const [reason, setReason] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const checkId = useId();
  const choice = choices.find((entry) => entry.value === chosen);
  const when = (iso: string) => t('backups.at', displayDateTime(new Date(iso)));
  const from = continuous.restorableFrom === null ? '' : when(continuous.restorableFrom);
  const moment = momentOf(momentText);
  const momentOk =
    moment !== null &&
    continuous.restorableFrom !== null &&
    moment.getTime() >= new Date(continuous.restorableFrom).getTime() - 60_000 &&
    moment.getTime() <= openedAt;
  const valid = chosen === LATEST || (chosen === MOMENT ? momentOk : choice !== undefined);
  const request = (reasonText: string): RestoreBackupRequest | undefined => {
    if (chosen === LATEST) return { pointInTime: { to: null }, reason: reasonText };
    if (chosen === MOMENT) {
      return moment === null
        ? undefined
        : { pointInTime: { to: moment.toISOString() }, reason: reasonText };
    }
    return choice === undefined
      ? undefined
      : { location: choice.location, fileName: choice.fileName, reason: reasonText };
  };
  const goesBackTo = (): string => {
    if (chosen === LATEST) return t('backups.restore.latestShort');
    if (chosen === MOMENT && moment !== null) return when(moment.toISOString());
    return choice === undefined ? '' : when(choice.takenAt);
  };
  let loss: string | undefined;
  if (chosen === LATEST) {
    loss = t('backups.restore.lossLatest', {
      when:
        continuous.lastArchivedAt === null
          ? t('backups.restore.latestShort')
          : when(continuous.lastArchivedAt),
    });
  } else if (chosen === MOMENT) {
    loss = momentOk ? t('backups.restore.loss', { when: when(moment.toISOString()) }) : undefined;
  } else if (choice !== undefined) {
    loss = t('backups.restore.loss', { when: when(choice.takenAt) });
  }

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={t('backups.restore.title')}
        description={t('backups.restore.intro')}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {t('backups.restore.cancel')}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={busy || !valid || !understood || reason.trim().length < 3}
              onClick={() => {
                const body = request(reason.trim());
                if (body === undefined) return;
                const label = goesBackTo();
                setBusy(true);
                setError(undefined);
                withSecondFactor(() => controller.api.restoreBackup({ body })).then(
                  () => {
                    setBusy(false);
                    onRequested(label);
                  },
                  (failure: unknown) => {
                    setBusy(false);
                    if (!(failure instanceof SecondFactorCancelled))
                      setError(messageOf(failure, t));
                  },
                );
              }}
            >
              {t('backups.restore.confirm')}
            </Button>
          </>
        }
      >
        {choices.length === 0 && !pointInTime ? (
          <p className="dashboard-section__hint">{t('backups.restore.none')}</p>
        ) : (
          <div className="console-form">
            <Select
              label={t('backups.restore.backup')}
              value={chosen}
              options={[
                ...(pointInTime
                  ? [
                      {
                        value: LATEST,
                        label:
                          continuous.lastArchivedAt === null
                            ? t('backups.restore.latestNever')
                            : t('backups.restore.latest', {
                                when: when(continuous.lastArchivedAt),
                              }),
                      },
                      { value: MOMENT, label: t('backups.restore.moment') },
                    ]
                  : []),
                ...choices.map((entry) => ({
                  value: entry.value,
                  label: t('backups.restore.choice', {
                    when: when(entry.takenAt),
                    where: t(`backups.location.${entry.location}`),
                  }),
                })),
              ]}
              onChange={(event) => {
                setChosen(event.target.value);
              }}
            />
            {chosen === MOMENT ? (
              <TextField
                label={t('backups.restore.momentLabel')}
                hint={t('backups.restore.momentHint', { from })}
                type="datetime-local"
                value={momentText}
                min={
                  continuous.restorableFrom === null
                    ? undefined
                    : inputOf(new Date(continuous.restorableFrom))
                }
                max={inputOf(new Date(openedAt))}
                error={momentOk ? undefined : t('backups.restore.momentInvalid', { from })}
                onChange={(event) => {
                  setMomentText(event.target.value);
                }}
              />
            ) : null}
            {loss === undefined ? null : (
              <p className="console-notice console-notice--warning">{loss}</p>
            )}
            <TextField
              label={t('backups.restore.reason')}
              hint={t('backups.restore.reasonHint')}
              value={reason}
              maxLength={200}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            <label className="menu-toolbar__check" htmlFor={checkId}>
              <input
                id={checkId}
                type="checkbox"
                checked={understood}
                onChange={(event) => {
                  setUnderstood(event.target.checked);
                }}
              />
              {t('backups.restore.understood')}
            </label>
          </div>
        )}
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
 * The backup recovery key (P7-05b), for the Owner to write down and keep away from the PC: with
 * it, the backups can be read on a new PC.
 */
export function RecoveryKeyButton() {
  const t = useT();
  const controller = useConsole();
  const { withSecondFactor, dialog } = useSecondFactor();
  const [shown, setShown] = useState<RecoveryKeyResponse | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  return (
    <>
      <Button
        variant="ghost"
        loading={busy}
        onClick={() => {
          setBusy(true);
          setError(undefined);
          withSecondFactor(() => controller.api.showRecoveryKey()).then(
            (key) => {
              setBusy(false);
              setShown(key);
            },
            (failure: unknown) => {
              setBusy(false);
              if (!(failure instanceof SecondFactorCancelled)) setError(messageOf(failure, t));
            },
          );
        }}
      >
        {t('backups.recovery.show')}
      </Button>
      {error === undefined ? null : (
        <p role="alert" className="console-notice console-notice--danger">
          {error}
        </p>
      )}
      {shown === undefined ? null : (
        <Dialog
          open
          onClose={() => {
            setShown(undefined);
          }}
          title={t('backups.recovery.title')}
          description={t('backups.recovery.intro')}
          footer={
            <Button
              onClick={() => {
                setShown(undefined);
              }}
            >
              {t('backups.recovery.done')}
            </Button>
          }
        >
          <p className="backups__recovery-key" aria-label={t('backups.recovery.key')}>
            {shown.recoveryKey}
          </p>
          <p className="dashboard-section__hint">{t('backups.recovery.keep')}</p>
        </Dialog>
      )}
      {dialog}
    </>
  );
}
