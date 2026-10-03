import type { BackupLocation, BackupsResponse, RecoveryKeyResponse } from '@rp/contracts';
import { displayDateTime } from '@rp/domain';
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

/**
 * Restore this PC from one of its backups (DATA-004, P7-05b): the Owner picks the backup, gives a
 * reason and confirms that everything after it is lost; the server restarts to do it.
 */
export function RestoreDialog({
  view,
  onClose,
  onRequested,
}: {
  view: BackupsResponse;
  onClose: () => void;
  onRequested: (backupCreatedAt: string) => void;
}) {
  const t = useT();
  const controller = useConsole();
  const { withSecondFactor, dialog } = useSecondFactor();
  const choices = restoreChoices(view);
  const [chosen, setChosen] = useState(choices[0]?.value ?? '');
  const [reason, setReason] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const checkId = useId();
  const choice = choices.find((entry) => entry.value === chosen);
  const when = (iso: string) => t('backups.at', displayDateTime(new Date(iso)));

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
              disabled={busy || choice === undefined || !understood || reason.trim().length < 3}
              onClick={() => {
                if (choice === undefined) return;
                setBusy(true);
                setError(undefined);
                withSecondFactor(() =>
                  controller.api.restoreBackup({
                    body: {
                      location: choice.location,
                      fileName: choice.fileName,
                      reason: reason.trim(),
                    },
                  }),
                ).then(
                  (requested) => {
                    setBusy(false);
                    onRequested(requested.backupCreatedAt);
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
        {choices.length === 0 ? (
          <p className="dashboard-section__hint">{t('backups.restore.none')}</p>
        ) : (
          <div className="console-form">
            <Select
              label={t('backups.restore.backup')}
              value={chosen}
              options={choices.map((entry) => ({
                value: entry.value,
                label: t('backups.restore.choice', {
                  when: when(entry.takenAt),
                  where: t(`backups.location.${entry.location}`),
                }),
              }))}
              onChange={(event) => {
                setChosen(event.target.value);
              }}
            />
            {choice === undefined ? null : (
              <p className="console-notice console-notice--warning">
                {t('backups.restore.loss', { when: when(choice.takenAt) })}
              </p>
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
