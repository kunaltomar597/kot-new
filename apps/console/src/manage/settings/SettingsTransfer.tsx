import type { SettingKey, SettingsExport, SettingsImportResponse } from '@rp/contracts';
import { Button, Dialog, useToast } from '@rp/ui-web';
import { useRef, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { downloadFile } from '../../app/download.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { SecondFactorCancelled, useSecondFactor } from '../../owner/second-factor.js';
import { parseSettingsFile, settingsFile } from './settings-transfer.js';

/**
 * Settings to a file and back (ONB-010, P7-07c): for a new PC or a reinstall. Each imported
 * setting is checked as if changed by hand; what was left alone is listed with the reason.
 */
export function SettingsTransfer({ onImported }: { onImported: () => void }) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { withSecondFactor, dialog: secondFactorDialog } = useSecondFactor();
  const input = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [chosen, setChosen] = useState<SettingsExport | undefined>();
  const [result, setResult] = useState<SettingsImportResponse | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  /** A setting this server does not know has no name to show, only its key. */
  const label = (key: string, known = true) =>
    known ? t(`settingLabels.${key as SettingKey}`) : key;

  const close = () => {
    setChosen(undefined);
    setResult(undefined);
    setBusy(false);
    setError(undefined);
  };

  return (
    <>
      <Button
        variant="secondary"
        loading={exporting}
        onClick={() => {
          setExporting(true);
          controller.api.exportSettings().then(
            (exported) => {
              setExporting(false);
              downloadFile(settingsFile(exported));
            },
            (failure: unknown) => {
              setExporting(false);
              toast.show({ title: messageOf(failure, t), tone: 'danger' });
            },
          );
        }}
      >
        {t('settingsPage.transfer.export')}
      </Button>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="menu-photo__input"
        aria-label={t('settingsPage.transfer.file')}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file === undefined) return;
          file.text().then(
            (text) => {
              const parsed = parseSettingsFile(text);
              if (parsed === undefined) {
                toast.show({ title: t('settingsPage.transfer.notAnExport'), tone: 'danger' });
              } else {
                setChosen(parsed);
              }
            },
            () => {
              toast.show({ title: t('settingsPage.transfer.notAnExport'), tone: 'danger' });
            },
          );
        }}
      />
      <Button
        variant="secondary"
        onClick={() => {
          input.current?.click();
        }}
      >
        {t('settingsPage.transfer.import')}
      </Button>
      {chosen === undefined ? null : (
        <Dialog
          open
          onClose={close}
          title={t('settingsPage.transfer.title')}
          description={
            result === undefined
              ? t('settingsPage.transfer.confirm', {
                  count: Object.keys(chosen.values).length,
                  restaurant: chosen.restaurantName,
                })
              : t('settingsPage.transfer.applied', { count: result.applied.length })
          }
          footer={
            result === undefined ? (
              <>
                <Button variant="ghost" onClick={close} disabled={busy}>
                  {t('settingsPage.dialog.cancel')}
                </Button>
                <Button
                  loading={busy}
                  disabled={busy || Object.keys(chosen.values).length === 0}
                  onClick={() => {
                    setBusy(true);
                    setError(undefined);
                    withSecondFactor(() => controller.api.importSettings({ body: chosen })).then(
                      (imported) => {
                        setBusy(false);
                        setResult(imported);
                        if (imported.applied.length > 0) onImported();
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
                  {t('settingsPage.transfer.apply')}
                </Button>
              </>
            ) : (
              <Button onClick={close}>{t('settingsPage.transfer.done')}</Button>
            )
          }
        >
          {result === undefined ? null : (
            <>
              {result.applied.length === 0 ? null : (
                <ul
                  className="settings-transfer__list"
                  aria-label={t('settingsPage.transfer.appliedList')}
                >
                  {result.applied.map((key) => (
                    <li key={key}>{label(key)}</li>
                  ))}
                </ul>
              )}
              {result.skipped.length === 0 ? null : (
                <>
                  <p className="dashboard-section__hint">
                    {t('settingsPage.transfer.skippedHint')}
                  </p>
                  <ul
                    className="settings-transfer__list"
                    aria-label={t('settingsPage.transfer.skippedList')}
                  >
                    {result.skipped.map((entry) => (
                      <li key={entry.key}>
                        {t('settingsPage.transfer.skipped', {
                          name: label(entry.key, entry.reason !== 'UNKNOWN'),
                          reason: t(`settingsPage.transfer.reason.${entry.reason}`),
                        })}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
          {error === undefined ? null : (
            <p role="alert" className="console-notice console-notice--danger">
              {error}
            </p>
          )}
        </Dialog>
      )}
      {secondFactorDialog}
    </>
  );
}
