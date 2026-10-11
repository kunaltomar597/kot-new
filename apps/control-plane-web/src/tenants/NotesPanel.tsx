import { Button, TextArea, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { when } from '../app/format.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useApi, useMay } from '../app/services.js';
import { useLoad } from '../app/use-load.js';
import { LoadView } from '../components/LoadView.js';

/** Notes about a restaurant for the support team (VCP-007): kept for good, newest first. */
export function NotesPanel({ tenantId }: { tenantId: string }) {
  const t = useT();
  const api = useApi();
  const may = useMay();
  const toast = useToast();
  const { data, reload } = useLoad(
    (signal) => api.listSupportNotes({ params: { id: tenantId }, signal }),
    `notes:${tenantId}`,
  );
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  return (
    <div className="cp-panel">
      {may('SUPPORT_NOTES') ? (
        <form
          className="cp-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (body.trim() === '' || busy) return;
            setBusy(true);
            setError(undefined);
            api.addSupportNote({ params: { id: tenantId }, body: { body: body.trim() } }).then(
              () => {
                setBusy(false);
                setBody('');
                toast.show({ title: t('vendorApp.notes.added'), tone: 'success' });
                reload();
              },
              (failure: unknown) => {
                setBusy(false);
                setError(messageOf(failure, t));
              },
            );
          }}
        >
          <TextArea
            label={t('vendorApp.notes.new')}
            hint={t('vendorApp.notes.hint')}
            value={body}
            maxLength={2_000}
            rows={3}
            onChange={(event) => {
              setBody(event.target.value);
            }}
          />
          {error === undefined ? null : (
            <p role="alert" className="cp-notice cp-notice--danger">
              {error}
            </p>
          )}
          <Button type="submit" loading={busy} disabled={busy || body.trim() === ''}>
            {t('vendorApp.notes.add')}
          </Button>
        </form>
      ) : null}
      <LoadView data={data} reload={reload} failed={t('vendorApp.notes.loadFailed')}>
        {({ notes }) =>
          notes.length === 0 ? (
            <p className="cp-hint">{t('vendorApp.notes.none')}</p>
          ) : (
            <ol className="cp-notes" aria-label={t('vendorApp.tenant.tab.notes')}>
              {notes.map((note) => (
                <li key={note.id} className="cp-note">
                  <p className="cp-note__meta">
                    {t('vendorApp.notes.meta', {
                      author: note.authorName ?? note.author,
                      at: when(note.createdAt),
                    })}
                  </p>
                  <p className="cp-note__body">{note.body}</p>
                </li>
              ))}
            </ol>
          )
        }
      </LoadView>
    </div>
  );
}
