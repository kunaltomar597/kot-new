import {
  CreateVendorUserRequest,
  VENDOR_ROLES,
  type VendorRole,
  type VendorSetupTokenView,
  type VendorUserView,
} from '@rp/contracts/control-plane';
import {
  Badge,
  Button,
  ChoiceGroup,
  ConfirmDialog,
  Dialog,
  Select,
  Table,
  TextField,
  useToast,
} from '@rp/ui-web';
import { useState } from 'react';
import { when, whenOrDash } from '../app/format.js';
import { useT } from '../app/i18n.js';
import { fieldErrors, messageOf } from '../app/messages.js';
import { useApi, useSession } from '../app/services.js';
import { useLoad } from '../app/use-load.js';
import { LoadView } from '../components/LoadView.js';
import { OneTimeSecret } from '../components/OneTimeSecret.js';
import { Page } from '../components/Page.js';

type AccountStatus = 'DISABLED' | 'LOCKED' | 'SETUP' | 'ACTIVE';
const STATUS_TONE = {
  ACTIVE: 'success',
  SETUP: 'info',
  LOCKED: 'warning',
  DISABLED: 'neutral',
} as const;

/** Where an account stands, most important first. */
export function accountStatus(user: VendorUserView, now = new Date()): AccountStatus {
  if (user.disabled) return 'DISABLED';
  if (user.lockedUntil !== null && new Date(user.lockedUntil) > now) return 'LOCKED';
  if (!user.active) return 'SETUP';
  return 'ACTIVE';
}

/** The one-time setup link for an account, on this app's own address. */
export function setupLink(token: string, origin = globalThis.location.origin): string {
  return `${origin}/setup#${token}`;
}

function SetupLinkDialog({
  issued,
  onClose,
}: {
  issued: VendorSetupTokenView | undefined;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Dialog
      open={issued !== undefined}
      onClose={onClose}
      title={t('vendorApp.staff.linkTitle', { name: issued?.user.name ?? '' })}
      footer={<Button onClick={onClose}>{t('vendorApp.actions.done')}</Button>}
    >
      {issued === undefined ? null : (
        <OneTimeSecret
          label={t('vendorApp.staff.link')}
          value={setupLink(issued.setupToken)}
          hint={t('vendorApp.staff.linkHint', { until: when(issued.setupExpiresAt) })}
        />
      )}
    </Dialog>
  );
}

function AddDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (issued: VendorSetupTokenView) => void;
}) {
  const t = useT();
  const api = useApi();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<VendorRole>('READ_ONLY');
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('vendorApp.staff.addTitle')}
      description={t('vendorApp.staff.addIntro')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('vendorApp.actions.cancel')}
          </Button>
          <Button
            loading={busy}
            disabled={busy || email.trim() === '' || name.trim() === ''}
            onClick={() => {
              const parsed = CreateVendorUserRequest.safeParse({ email, name, role });
              if (!parsed.success) {
                setErrors(fieldErrors(parsed.error));
                return;
              }
              setErrors({});
              setBusy(true);
              setError(undefined);
              api.createVendorUser({ body: parsed.data }).then(onAdded, (failure: unknown) => {
                setBusy(false);
                setError(messageOf(failure, t));
              });
            }}
          >
            {t('vendorApp.staff.add')}
          </Button>
        </>
      }
    >
      <div className="cp-form">
        <TextField
          label={t('vendorApp.staff.email')}
          type="email"
          value={email}
          error={errors.email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
        <TextField
          label={t('vendorApp.staff.name')}
          value={name}
          maxLength={120}
          error={errors.name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <Select
          label={t('vendorApp.staff.role')}
          hint={t('vendorApp.staff.roleHint')}
          value={role}
          options={VENDOR_ROLES.map((value) => ({ value, label: t(`vendorApp.roles.${value}`) }))}
          onChange={(event) => {
            setRole(event.target.value as VendorRole);
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

function ChangeDialog({
  user,
  onClose,
  onSaved,
}: {
  user: VendorUserView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const api = useApi();
  const [role, setRole] = useState<VendorRole>(user.role);
  const [disabled, setDisabled] = useState(user.disabled);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const changed = role !== user.role || disabled !== user.disabled;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('vendorApp.staff.changeTitle', { name: user.name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('vendorApp.actions.cancel')}
          </Button>
          <Button
            loading={busy}
            disabled={busy || !changed || reason.trim().length < 3}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              api
                .updateVendorUser({
                  params: { id: user.id },
                  body: {
                    ...(role !== user.role && { role }),
                    ...(disabled !== user.disabled && { disabled }),
                    reason: reason.trim(),
                  },
                })
                .then(onSaved, (failure: unknown) => {
                  setBusy(false);
                  setError(messageOf(failure, t));
                });
            }}
          >
            {t('vendorApp.actions.save')}
          </Button>
        </>
      }
    >
      <div className="cp-form">
        <Select
          label={t('vendorApp.staff.role')}
          value={role}
          options={VENDOR_ROLES.map((value) => ({ value, label: t(`vendorApp.roles.${value}`) }))}
          onChange={(event) => {
            setRole(event.target.value as VendorRole);
          }}
        />
        <ChoiceGroup
          legend={t('vendorApp.staff.access')}
          mode="single"
          options={[
            { id: 'enabled', label: t('vendorApp.staff.enabled') },
            { id: 'disabled', label: t('vendorApp.staff.disabledChoice') },
          ]}
          value={[disabled ? 'disabled' : 'enabled']}
          onChange={(value) => {
            setDisabled(value[0] === 'disabled');
          }}
        />
        <TextField
          label={t('vendorApp.reason.label')}
          hint={t('vendorApp.reason.hint')}
          value={reason}
          maxLength={200}
          onChange={(event) => {
            setReason(event.target.value);
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

function ReviewDialog({
  users,
  selfId,
  onClose,
  onSaved,
}: {
  users: readonly VendorUserView[];
  selfId: string;
  onClose: () => void;
  onSaved: (kept: readonly VendorUserView[]) => void;
}) {
  const t = useT();
  const api = useApi();
  const candidates = users.filter((user) => !user.disabled && user.id !== selfId);
  const [keep, setKeep] = useState<string[]>(() => candidates.map((user) => user.id));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const removing = candidates.length - keep.length;
  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={t('vendorApp.staff.reviewTitle')}
      description={t('vendorApp.staff.reviewIntro')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('vendorApp.actions.cancel')}
          </Button>
          <Button
            variant={removing > 0 ? 'danger' : 'primary'}
            loading={busy}
            disabled={busy || note.trim().length < 3}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              api.recordVendorAccessReview({ body: { keep, note: note.trim() } }).then(
                ({ users: after }) => {
                  onSaved(after);
                },
                (failure: unknown) => {
                  setBusy(false);
                  setError(messageOf(failure, t));
                },
              );
            }}
          >
            {removing > 0
              ? t('vendorApp.staff.reviewDisable', { count: removing })
              : t('vendorApp.staff.reviewKeepAll')}
          </Button>
        </>
      }
    >
      <ChoiceGroup
        legend={t('vendorApp.staff.reviewKeep')}
        hint={t('vendorApp.staff.reviewSelf')}
        mode="multiple"
        options={candidates.map((user) => ({
          id: user.id,
          label: user.name,
          detail: t('vendorApp.staff.reviewDetail', {
            role: t(`vendorApp.roles.${user.role}`),
            seen: whenOrDash(user.lastSignInAt),
          }),
        }))}
        value={keep}
        onChange={setKeep}
      />
      <TextField
        label={t('vendorApp.staff.reviewNote')}
        hint={t('vendorApp.staff.reviewNoteHint')}
        value={note}
        maxLength={500}
        onChange={(event) => {
          setNote(event.target.value);
        }}
      />
      {error === undefined ? null : (
        <p role="alert" className="cp-notice cp-notice--danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/**
 * Vendor staff accounts (VCP-001, SEC-018): who has which role, when they last signed in and were
 * last reviewed. The Super Admin adds people (their setup link is shown once), changes a role or
 * disables an account with a reason, resets a lost authenticator, and records the quarterly
 * access review.
 */
export function StaffScreen() {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const session = useSession();
  const selfId = session.status === 'signedIn' ? session.me.user.id : '';
  const { data, reload } = useLoad((signal) => api.listVendorUsers({ signal }), 'staff');
  const [open, setOpen] = useState<
    | { kind: 'add' }
    | { kind: 'review' }
    | { kind: 'change'; user: VendorUserView }
    | { kind: 'reset'; user: VendorUserView }
    | undefined
  >();
  const [issued, setIssued] = useState<VendorSetupTokenView | undefined>();
  const [busy, setBusy] = useState(false);
  const close = () => {
    setOpen(undefined);
  };

  return (
    <Page
      title={t('vendorApp.staff.title')}
      intro={t('vendorApp.staff.intro')}
      actions={
        <>
          <Button
            variant="secondary"
            disabled={data.status !== 'ready'}
            onClick={() => {
              setOpen({ kind: 'review' });
            }}
          >
            {t('vendorApp.staff.review')}
          </Button>
          <Button
            onClick={() => {
              setOpen({ kind: 'add' });
            }}
          >
            {t('vendorApp.staff.add')}
          </Button>
        </>
      }
    >
      <LoadView data={data} reload={reload} failed={t('vendorApp.staff.loadFailed')}>
        {({ users }) => (
          <>
            <Table
              caption={t('vendorApp.staff.title')}
              hideCaption
              rows={users}
              rowKey={(user) => user.id}
              columns={[
                {
                  key: 'name',
                  header: t('vendorApp.staff.name'),
                  cell: (user) => (
                    <>
                      {user.name}
                      <br />
                      <span className="cp-hint">{user.email}</span>
                    </>
                  ),
                },
                {
                  key: 'role',
                  header: t('vendorApp.staff.role'),
                  cell: (user) => t(`vendorApp.roles.${user.role}`),
                },
                {
                  key: 'status',
                  header: t('vendorApp.staff.status'),
                  cell: (user) => {
                    const status = accountStatus(user);
                    return (
                      <Badge tone={STATUS_TONE[status]}>
                        {status === 'LOCKED'
                          ? t('vendorApp.staff.state.LOCKED', {
                              until: when(user.lockedUntil ?? ''),
                            })
                          : t(`vendorApp.staff.state.${status}`)}
                      </Badge>
                    );
                  },
                },
                {
                  key: 'seen',
                  header: t('vendorApp.staff.lastSignIn'),
                  cell: (user) => whenOrDash(user.lastSignInAt),
                },
                {
                  key: 'reviewed',
                  header: t('vendorApp.staff.reviewedAt'),
                  cell: (user) => whenOrDash(user.reviewedAt),
                },
                {
                  key: 'actions',
                  header: t('vendorApp.actions.header'),
                  cell: (user) =>
                    user.id === selfId ? (
                      <span className="cp-hint">{t('vendorApp.staff.you')}</span>
                    ) : (
                      <div className="cp-actions">
                        <Button
                          variant="secondary"
                          aria-label={t('vendorApp.staff.changeFor', { name: user.name })}
                          onClick={() => {
                            setOpen({ kind: 'change', user });
                          }}
                        >
                          {t('vendorApp.staff.change')}
                        </Button>
                        {user.disabled ? null : (
                          <Button
                            variant="ghost"
                            aria-label={t('vendorApp.staff.resetFor', { name: user.name })}
                            onClick={() => {
                              setOpen({ kind: 'reset', user });
                            }}
                          >
                            {t('vendorApp.staff.reset')}
                          </Button>
                        )}
                      </div>
                    ),
                },
              ]}
            />
            {open?.kind === 'review' ? (
              <ReviewDialog
                users={users}
                selfId={selfId}
                onClose={close}
                onSaved={(after) => {
                  close();
                  const disabled = after.filter((user) => user.disabled).length;
                  toast.show({
                    title: t('vendorApp.staff.reviewed', {
                      count: disabled - users.filter((user) => user.disabled).length,
                    }),
                    tone: 'success',
                  });
                  reload();
                }}
              />
            ) : null}
          </>
        )}
      </LoadView>
      {open?.kind === 'add' ? (
        <AddDialog
          onClose={close}
          onAdded={(created) => {
            close();
            setIssued(created);
            reload();
          }}
        />
      ) : null}
      {open?.kind === 'change' ? (
        <ChangeDialog
          user={open.user}
          onClose={close}
          onSaved={() => {
            close();
            toast.show({ title: t('vendorApp.staff.changed'), tone: 'success' });
            reload();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={open?.kind === 'reset'}
        title={t('vendorApp.staff.resetTitle', {
          name: open?.kind === 'reset' ? open.user.name : '',
        })}
        description={t('vendorApp.staff.resetIntro')}
        confirmLabel={t('vendorApp.staff.reset')}
        cancelLabel={t('vendorApp.actions.cancel')}
        tone="danger"
        busy={busy}
        onCancel={close}
        onConfirm={() => {
          if (open?.kind !== 'reset') return;
          setBusy(true);
          api.resetVendorUser({ params: { id: open.user.id } }).then(
            (reset) => {
              setBusy(false);
              close();
              setIssued(reset);
              reload();
            },
            (failure: unknown) => {
              setBusy(false);
              close();
              toast.show({ title: messageOf(failure, t), tone: 'danger' });
            },
          );
        }}
      />
      <SetupLinkDialog
        issued={issued}
        onClose={() => {
          setIssued(undefined);
        }}
      />
    </Page>
  );
}
