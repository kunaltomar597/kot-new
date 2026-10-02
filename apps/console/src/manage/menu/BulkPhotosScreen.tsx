import { type ItemView, PHOTO_MAX_BYTES } from '@rp/contracts';
import { matchPhotos } from '@rp/domain';
import { Badge, Button, ErrorState, LoadingState, Select, useToast } from '@rp/ui-web';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { base64Of } from '../PhotoPicker.js';

interface Row {
  readonly key: string;
  readonly file: File;
  /** A preview of the photo, made in this browser. */
  readonly preview: string;
  readonly itemId: string;
  readonly by: 'CODE' | 'NAME' | 'PERSON' | null;
  readonly result?: { readonly ok: true } | { readonly ok: false; readonly message: string };
}

let rows = 0;

/**
 * Bulk photo upload (P6-04c, ONB-007): many dish photos at once, each matched to a dish by its
 * file name or short code (`matchPhotos` in `@rp/domain`), with a dish list on every row to
 * correct the match. Each photo is uploaded like a single one (checked and re-encoded, P1-04),
 * then set on its dish as a draft change; publishing shows them everywhere.
 */
export function BulkPhotosScreen() {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const { data, reload } = useLive(
    async () =>
      (await controller.api.getMenuDraft()).items.filter((item) => item.archivedAt === null),
    (type) => type === 'MenuPublished',
  );
  const [chosen, setChosen] = useState<readonly Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploaded, setUploaded] = useState<number | undefined>();

  // Previews are released when the page goes.
  const previews = useRef(new Set<string>());
  useEffect(() => {
    const made = previews.current;
    return () => {
      for (const url of made) URL.revokeObjectURL(url);
    };
  }, []);

  const items: readonly ItemView[] = data.status === 'ready' ? data.value : [];

  const add = (files: readonly File[]) => {
    const all = [...chosen.map((row) => row.file), ...files];
    const matches = matchPhotos(
      all.map((file) => file.name),
      items.map((item) => ({ id: item.id, name: item.name, shortCode: item.shortCode })),
    );
    const next = all.map((file, index): Row => {
      const existing = chosen[index];
      if (existing !== undefined) return existing;
      const match = matches[index];
      const preview = URL.createObjectURL(file);
      previews.current.add(preview);
      rows += 1;
      return {
        key: `photo-${String(rows)}`,
        file,
        preview,
        itemId: match?.itemId ?? '',
        by: match?.by ?? null,
      };
    });
    setChosen(next);
    setUploaded(undefined);
  };

  /** A dish chosen for two photos keeps the first. */
  const takenBefore = (index: number) => {
    const itemId = chosen[index]?.itemId ?? '';
    return itemId !== '' && chosen.slice(0, index).some((row) => row.itemId === itemId);
  };
  const ready = chosen.filter(
    (row, index) =>
      row.itemId !== '' &&
      row.result?.ok !== true &&
      row.file.size <= PHOTO_MAX_BYTES &&
      !takenBefore(index),
  );

  const upload = async () => {
    setBusy(true);
    let done = 0;
    const results = new Map<string, Row['result']>();
    for (const row of ready) {
      try {
        const photo = await controller.api.uploadPhoto({
          body: { contentBase64: await base64Of(row.file) },
        });
        await controller.api.setItemPhoto({
          params: { id: row.itemId },
          body: { photoId: photo.id },
        });
        results.set(row.key, { ok: true });
        done += 1;
      } catch (error) {
        results.set(row.key, { ok: false, message: messageOf(error, t) });
      }
    }
    setChosen((current) =>
      current.map((row) => {
        const result = results.get(row.key);
        return result === undefined ? row : { ...row, result };
      }),
    );
    setUploaded(done);
    setBusy(false);
    if (done > 0) toast.show({ title: t('bulkPhotos.done', { count: done }), tone: 'success' });
    reload();
  };

  let content: ReactNode;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('menuEditor.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const options = items
      .map((item) => ({ value: item.id, label: item.name }))
      .sort((a, b) => a.label.localeCompare(b.label));
    content = (
      <>
        <p className="menu-photo__label">{t('bulkPhotos.files')}</p>
        <p className="dashboard-section__hint">{t('bulkPhotos.filesHint')}</p>
        <input
          ref={input}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
          className="menu-photo__input"
          aria-label={t('bulkPhotos.files')}
          onChange={(event) => {
            add(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <Button
          variant="secondary"
          onClick={() => {
            input.current?.click();
          }}
        >
          {t('bulkPhotos.choose')}
        </Button>
        {chosen.length === 0 ? null : (
          <ul className="staff-list" aria-label={t('bulkPhotos.files')}>
            {chosen.map((row, index) => {
              const problem =
                row.file.size > PHOTO_MAX_BYTES
                  ? t('bulkPhotos.tooLarge')
                  : takenBefore(index)
                    ? t('bulkPhotos.taken')
                    : undefined;
              return (
                <li key={row.key} className="staff-row bulk-photos__row">
                  <img
                    className="menu-photo__preview"
                    src={row.preview}
                    alt=""
                    width={64}
                    height={64}
                  />
                  <div className="staff-row__who">
                    <span className="staff-row__name">{row.file.name}</span>
                    <Select
                      label={t('bulkPhotos.dish', { file: row.file.name })}
                      placeholder={t('bulkPhotos.noDish')}
                      value={row.itemId}
                      options={options}
                      error={problem}
                      disabled={row.result?.ok === true}
                      onChange={(event) => {
                        setChosen(
                          chosen.map((entry) =>
                            entry.key === row.key
                              ? { ...entry, itemId: event.target.value, by: 'PERSON' }
                              : entry,
                          ),
                        );
                      }}
                    />
                    <p className="staff-row__states">
                      {row.result === undefined ? (
                        <Badge tone={row.itemId === '' ? 'warning' : 'neutral'}>
                          {row.itemId === ''
                            ? t('bulkPhotos.unmatched')
                            : row.by === 'CODE'
                              ? t('bulkPhotos.byCode')
                              : row.by === 'NAME'
                                ? t('bulkPhotos.byName')
                                : t('bulkPhotos.byPerson')}
                        </Badge>
                      ) : row.result.ok ? (
                        <Badge tone="success">{t('bulkPhotos.uploaded')}</Badge>
                      ) : (
                        <Badge tone="danger">
                          {t('bulkPhotos.failed', { message: row.result.message })}
                        </Badge>
                      )}
                    </p>
                  </div>
                  {row.result?.ok === true ? null : (
                    <Button
                      variant="ghost"
                      aria-label={t('bulkPhotos.remove', { file: row.file.name })}
                      onClick={() => {
                        setChosen(chosen.filter((entry) => entry.key !== row.key));
                      }}
                    >
                      {t('aiImport.review.leaveOut')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <Button
          loading={busy}
          disabled={ready.length === 0}
          onClick={() => {
            void upload();
          }}
        >
          {t('bulkPhotos.upload', { count: ready.length })}
        </Button>
        {uploaded === undefined || uploaded === 0 ? null : (
          <p role="status">
            {t('bulkPhotos.done', { count: uploaded })}{' '}
            <Link to="/manage/menu" className="staff-pages__link">
              {t('bulkPhotos.toEditor')}
            </Link>
          </p>
        )}
      </>
    );
  }

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-bulk-photos">
      <div className="staff-header">
        <h2 id="dashboard-bulk-photos" className="dashboard-section__heading">
          {t('bulkPhotos.title')}
        </h2>
        <Link to="/manage/menu" className="staff-pages__link">
          {t('bulkPhotos.back')}
        </Link>
      </div>
      <p className="dashboard-section__hint">{t('bulkPhotos.intro')}</p>
      {content}
    </section>
  );
}
