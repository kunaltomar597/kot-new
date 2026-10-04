import {
  type FleetInstallationView,
  PublishReleaseRequest,
  RELEASE_CHANNELS,
  type ReleaseChannel,
  type VendorReleaseView,
} from '@rp/contracts/control-plane';
import {
  Badge,
  Button,
  ChoiceGroup,
  Dialog,
  Select,
  Table,
  TextArea,
  TextField,
  useToast,
} from '@rp/ui-web';
import { useState } from 'react';
import { when } from '../app/format.js';
import { useT } from '../app/i18n.js';
import { fieldErrors, messageOf } from '../app/messages.js';
import { useApi, useMay } from '../app/services.js';
import { useLoad } from '../app/use-load.js';
import { LoadView } from '../components/LoadView.js';
import { Page } from '../components/Page.js';
import { defaultPercent, installsLabel, percentOf, rolloutLabel } from './release-view.js';
import { RolloutDialog } from './RolloutDialog.js';

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
  readonly percent: string;
  readonly securityCritical: boolean;
  /** A hotfix's PC; empty for the channel. */
  readonly target: string;
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
    securityCritical: draft.securityCritical,
    // A hotfix goes to its PC whatever the share.
    rolloutPercent: draft.target === '' ? (percentOf(draft.percent) ?? Number.NaN) : 100,
    targetInstallationId: draft.target === '' ? null : draft.target,
  });
}

function PublishDialog({
  pcs,
  onClose,
  onSaved,
}: {
  pcs: readonly FleetInstallationView[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const api = useApi();
  const [draft, setDraft] = useState<ReleaseDraft>({
    channel: 'PILOT',
    version: '',
    url: '',
    sha256: '',
    sizeBytes: '',
    notes: '',
    percent: String(defaultPercent('PILOT')),
    securityCritical: false,
    target: '',
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
  const onChannel = pcs.filter((pc) => pc.channel === draft.channel);
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
            const channel = event.target.value as ReleaseChannel;
            setDraft({ ...draft, channel, percent: String(defaultPercent(channel)), target: '' });
          }}
        />
        {text('version', t('vendorApp.releases.versionHint'))}
        {text('url', t('vendorApp.releases.urlHint'))}
        {text('sha256', t('vendorApp.releases.sha256Hint'))}
        {text('sizeBytes')}
        <Select
          label={t('vendorApp.releases.hotfixPc')}
          value={draft.target}
          options={[
            { value: '', label: t('vendorApp.releases.hotfixNone') },
            ...onChannel.map((pc) => ({
              value: pc.installationId,
              label: t('vendorApp.releases.pcName', {
                pc: pc.installationName,
                tenant: pc.tenantName,
              }),
            })),
          ]}
          onChange={(event) => {
            setDraft({ ...draft, target: event.target.value });
          }}
        />
        {draft.target === '' ? (
          <TextField
            label={t('vendorApp.releases.startPercent')}
            hint={t('vendorApp.releases.startPercentHint')}
            inputMode="numeric"
            value={draft.percent}
            error={errors.rolloutPercent}
            onChange={(event) => {
              setDraft({ ...draft, percent: event.target.value });
            }}
          />
        ) : null}
        <ChoiceGroup
          legend={t('vendorApp.releases.securityBadge')}
          mode="multiple"
          options={[{ id: 'security', label: t('vendorApp.releases.securityCritical') }]}
          value={draft.securityCritical ? ['security'] : []}
          onChange={(value) => {
            setDraft({ ...draft, securityCritical: value.includes('security') });
          }}
        />
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

const STATE_TONE = { ACTIVE: 'success', PAUSED: 'warning', HALTED: 'danger' } as const;

/**
 * Releases on each channel (VCP-006) and their rollouts (UPD-003): how far each has gone, how
 * installing it went, and, for the Super Admin, publishing and changing a rollout.
 */
export function ReleasesScreen() {
  const t = useT();
  const api = useApi();
  const may = useMay();
  const toast = useToast();
  const { data, reload } = useLoad(async (signal) => {
    const [releases, fleet] = await Promise.all([
      api.listVendorReleases({ signal }),
      may('RELEASES_MANAGE')
        ? api.getFleet({ signal }).then((answer) => answer.installations)
        : Promise.resolve([]),
    ]);
    return { releases: releases.releases, pcs: fleet };
  }, 'releases');
  const [publishing, setPublishing] = useState(false);
  const [changing, setChanging] = useState<VendorReleaseView | undefined>();
  const manages = may('RELEASES_MANAGE');

  return (
    <Page
      title={t('vendorApp.releases.title')}
      intro={t('vendorApp.releases.intro')}
      actions={
        manages ? (
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
        {({ releases, pcs }) => (
          <>
            <Table
              caption={t('vendorApp.releases.title')}
              hideCaption
              rows={releases}
              rowKey={(release) => release.id}
              empty={t('vendorApp.releases.empty')}
              columns={[
                {
                  key: 'version',
                  header: t('vendorApp.releases.version'),
                  cell: (release) => (
                    <>
                      {release.version}
                      {release.securityCritical ? (
                        <>
                          {' '}
                          <Badge tone="danger">{t('vendorApp.releases.securityBadge')}</Badge>
                        </>
                      ) : null}
                    </>
                  ),
                },
                {
                  key: 'channel',
                  header: t('vendorApp.installation.channel'),
                  cell: (release) => t(`vendorApp.channel.${release.channel}`),
                },
                {
                  key: 'rollout',
                  header: t('vendorApp.releases.rollout'),
                  cell: (release) => (
                    <>
                      <Badge tone={STATE_TONE[release.rollout.state]}>
                        {rolloutLabel(release, t)}
                      </Badge>
                      {release.rollout.haltReason === null ? null : (
                        <p className="cp-muted">
                          {t('vendorApp.releases.haltReason', {
                            reason: release.rollout.haltReason,
                          })}
                        </p>
                      )}
                    </>
                  ),
                },
                {
                  key: 'installs',
                  header: t('vendorApp.releases.installsColumn'),
                  cell: (release) => installsLabel(release, t),
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
                ...(manages
                  ? [
                      {
                        key: 'actions',
                        header: t('vendorApp.releases.rollout'),
                        cell: (release: VendorReleaseView) =>
                          release.target === null ? (
                            <Button
                              variant="secondary"
                              aria-label={t('vendorApp.releases.rolloutFor', {
                                version: release.version,
                              })}
                              onClick={() => {
                                setChanging(release);
                              }}
                            >
                              {t('vendorApp.releases.rollout')}
                            </Button>
                          ) : null,
                      },
                    ]
                  : []),
              ]}
            />
            {publishing ? (
              <PublishDialog
                pcs={pcs}
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
            {changing === undefined ? null : (
              <RolloutDialog
                release={changing}
                pcs={pcs.filter((pc) => pc.channel === changing.channel)}
                onClose={() => {
                  setChanging(undefined);
                }}
                onSave={async (rollout) => {
                  await api.updateVendorRollout({ params: { id: changing.id }, body: rollout });
                  setChanging(undefined);
                  toast.show({ title: t('vendorApp.releases.rolloutSaved'), tone: 'success' });
                  reload();
                }}
              />
            )}
          </>
        )}
      </LoadView>
    </Page>
  );
}
