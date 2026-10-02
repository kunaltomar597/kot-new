import { Button, Dialog, TextArea, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { downloadFile } from '../../app/download.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';

/** Support's short reference for a bundle: the first block of its id, as people read it out. */
export function diagnosticsReference(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

/**
 * "Send diagnostics to support" (UPD-008): what is sent and what never is, the bundle to see (or
 * email) first, and sending it with a note. Passwords, keys and guests' phone numbers and email
 * addresses are removed on this PC before anything leaves it.
 */
export function DiagnosticsPanel({ connected }: { connected: boolean }) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'preview' | 'send' | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [sent, setSent] = useState<string | undefined>();

  const close = () => {
    setOpen(false);
    setNote('');
    setError(undefined);
  };

  return (
    <section className="device-group" aria-labelledby="system-support">
      <h3 id="system-support" className="device-group__heading">
        {t('systemPage.diagnostics.title')}
      </h3>
      <p className="dashboard-section__hint">{t('systemPage.diagnostics.intro')}</p>
      <div className="staff-row__actions">
        <Button
          variant="ghost"
          loading={busy === 'preview'}
          disabled={busy !== undefined}
          onClick={() => {
            setBusy('preview');
            controller.api.previewDiagnostics().then(
              (bundle) => {
                setBusy(undefined);
                downloadFile({
                  filename: `diagnostics-${bundle.generatedAt.slice(0, 10)}.json`,
                  contentType: 'application/json',
                  encoding: 'utf-8',
                  content: JSON.stringify(bundle, null, 2),
                });
              },
              (failure: unknown) => {
                setBusy(undefined);
                toast.show({ title: messageOf(failure, t), tone: 'danger' });
              },
            );
          }}
        >
          {t('systemPage.diagnostics.preview')}
        </Button>
        <Button
          variant="secondary"
          disabled={!connected || busy !== undefined}
          aria-describedby={connected ? undefined : 'system-diagnostics-hint'}
          onClick={() => {
            setOpen(true);
          }}
        >
          {t('systemPage.diagnostics.send')}
        </Button>
      </div>
      {connected ? null : (
        <p id="system-diagnostics-hint" className="dashboard-section__hint">
          {t('systemPage.diagnostics.unavailable')}
        </p>
      )}
      {sent === undefined ? null : (
        <p className="dashboard-section__hint" role="status">
          {t('systemPage.diagnostics.sent', { reference: sent })}
        </p>
      )}
      <Dialog
        open={open}
        onClose={close}
        title={t('systemPage.diagnostics.send')}
        description={t('systemPage.diagnostics.dialogIntro')}
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={busy === 'send'}>
              {t('systemPage.diagnostics.cancel')}
            </Button>
            <Button
              loading={busy === 'send'}
              disabled={busy !== undefined}
              onClick={() => {
                setBusy('send');
                setError(undefined);
                controller.api
                  .sendDiagnostics({ body: { note: note.trim() === '' ? null : note.trim() } })
                  .then(
                    (result) => {
                      setBusy(undefined);
                      const reference = diagnosticsReference(result.id);
                      setSent(reference);
                      close();
                      toast.show({
                        title: t('systemPage.diagnostics.sent', { reference }),
                        tone: 'success',
                      });
                    },
                    (failure: unknown) => {
                      setBusy(undefined);
                      setError(messageOf(failure, t));
                    },
                  );
              }}
            >
              {t('systemPage.diagnostics.confirm')}
            </Button>
          </>
        }
      >
        <TextArea
          label={t('systemPage.diagnostics.note')}
          hint={t('systemPage.diagnostics.noteHint')}
          value={note}
          maxLength={500}
          rows={3}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
      </Dialog>
    </section>
  );
}
