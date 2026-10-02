import {
  PublishReleaseRequest,
  RELEASE_CHANNELS,
  type ReleaseChannel,
} from '@rp/contracts/control-plane';
import { Button, Dialog, Select, Table, TextArea, TextField, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { when } from '../app/format.js';
import { useT } from '../app/i18n.js';
import { fieldErrors, messageOf } from '../app/messages.js';
import { useApi, useMay } from '../app/services.js';
import { useLoad } from '../app/use-load.js';
import { LoadView } from '../components/LoadView.js';
import { Page } from '../components/Page.js';

/** Bytes as megabytes with one decimal, for people. */
export function megabytes(bytes: number): string {
  return (bytes / 1_048_576).toFixed(1);
}

interface ReleaseDraft {
  readonly channel: ReleaseChannel;
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly sizeBytes: string;
  readonly notes: string;
}

/** The form as a publish request; the checksum is compared in lower case. */
export function releaseRequestOf(draft: ReleaseDraft) {
  return PublishReleaseRequest.safeParse({
    component: 'RESTAURANT_PC',
    channel: draft.channel,
    version: draft.version.trim(),
    url: draft.url.trim(),
    sha256: draft.sha256.trim().toLowerCase(),
    sizeBytes: /^\d+$/.test(draft.sizeBytes.trim()) ? Number(draft.sizeBytes.trim()) : Number.NaN,
    notes: draft.notes.trim() === '' ? null : draft.notes.trim(),
  });
}

function PublishDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const api = useApi();
  const [draft, setDraft] = useState<ReleaseDraft>({
    channel: 'PILOT',
    version: '',
    url: '',
    sha256: '',
    sizeBytes: '',
    notes: '',
  });
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const text = (key: 'version' | 'url' | 'sha256' | 'sizeBytes', hint?: string) => (
    <TextField
      label={t(`vendorApp.releases.${key}`)}
      hint={hint}
      value={draft[key]}
      error={errors[key]}
      inputMode={key === 'sizeBytes' ? 'numeric' : undefined}
      onChange={(event) => {
        setDraft({ ...draft, [key]: event.target.value });
      }}
    />
  );
  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={t('vendorApp.releases.publishTitle')}
      description={t('vendorApp.releases.publishIntro')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('vendorApp.actions.cancel')}
          </Button>
          <Button
            loading={busy}
            disabled={busy}
            onClick={() => {
              const parsed = releaseRequestOf(draft);
              if (!parsed.success) {
                setErrors(fieldErrors(parsed.error));
                return;
              }
              setErrors({});
              setBusy(true);
              setError(undefined);
              api.publishVendorRelease({ body: parsed.data }).then(onSaved, (failure: unknown) => {
                setBusy(false);
                setError(messageOf(failure, t));
              });
            }}
          >
            {t('vendorApp.releases.publish')}
          </Button>
        </>
      }
    >
      <div className="cp-form">
        <Select
          label={t('vendorApp.installation.channel')}
          value={draft.channel}
          options={RELEASE_CHANNELS.map((value) => ({
            value,
            label: t(`vendorApp.channel.${value}`),
          }))}
          onChange={(event) => {
            setDraft({ ...draft, channel: event.target.value as ReleaseChannel });
          }}
        />
        {text('version', t('vendorApp.releases.versionHint'))}
        {text('url', t('vendorApp.releases.urlHint'))}
        {text('sha256', t('vendorApp.releases.sha256Hint'))}
        {text('sizeBytes')}
        <TextArea
          label={t('vendorApp.releases.notes')}
          value={draft.notes}
          maxLength={2_000}
          rows={3}
          onChange={(event) => {
            setDraft({ ...draft, notes: event.target.value });
          }}
        />
      </div>
      {error === undefined ? null : (
        <p role="alert" className="cp-notice cp-notice--danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** Releases on each channel (VCP-006): what PCs are offered; the Super Admin publishes. */
export function ReleasesScreen() {
  const t = useT();
  const api = useApi();
  const may = useMay();
  const toast = useToast();
  const { data, reload } = useLoad((signal) => api.listVendorReleases({ signal }), 'releases');
  const [publishing, setPublishing] = useState(false);

  return (
    <Page
      title={t('vendorApp.releases.title')}
      intro={t('vendorApp.releases.intro')}
      actions={
        may('RELEASES_MANAGE') ? (
          <Button
            onClick={() => {
              setPublishing(true);
            }}
          >
            {t('vendorApp.releases.publish')}
          </Button>
        ) : undefined
      }
    >
      <LoadView data={data} reload={reload} failed={t('vendorApp.releases.loadFailed')}>
        {({ releases }) => (
          <Table
            caption={t('vendorApp.releases.title')}
            hideCaption
            rows={releases}
            rowKey={(release) => `${release.channel}:${release.version}`}
            empty={t('vendorApp.releases.empty')}
            columns={[
              {
                key: 'version',
                header: t('vendorApp.releases.version'),
                cell: (release) => release.version,
              },
              {
                key: 'channel',
                header: t('vendorApp.installation.channel'),
                cell: (release) => t(`vendorApp.channel.${release.channel}`),
              },
              {
                key: 'published',
                header: t('vendorApp.releases.publishedAt'),
                cell: (release) => when(release.publishedAt),
              },
              {
                key: 'size',
                header: t('vendorApp.releases.size'),
                align: 'end',
                cell: (release) =>
                  t('vendorApp.releases.megabytes', { size: megabytes(release.sizeBytes) }),
              },
              {
                key: 'sha',
                header: t('vendorApp.releases.sha256'),
                cell: (release) => (
                  <code title={release.sha256}>{release.sha256.slice(0, 12)}…</code>
                ),
              },
              {
                key: 'notes',
                header: t('vendorApp.releases.notes'),
                cell: (release) => release.notes ?? '—',
              },
            ]}
          />
        )}
      </LoadView>
      {publishing ? (
        <PublishDialog
          onClose={() => {
            setPublishing(false);
          }}
          onSaved={() => {
            setPublishing(false);
            toast.show({ title: t('vendorApp.releases.published'), tone: 'success' });
            reload();
          }}
        />
      ) : null}
    </Page>
  );
}
