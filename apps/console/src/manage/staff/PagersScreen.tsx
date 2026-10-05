import type {
  PagerCredentialResponse,
  PagerFirmwarePagerView,
  PagerFirmwareResponse,
  PagerView,
  StaffView,
} from '@rp/contracts';
import { timeOfDayOf } from '@rp/domain';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  useToast,
} from '@rp/ui-web';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useConsole, useConsoleState } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { grantOf } from '../../app/modes.js';
import { type LiveData, useLive } from '../../app/use-live.js';
import { GivePagerDialog, PagerCredentialDialog, RegisterPagerDialog } from './PagerDialogs.js';
import { batteryOf, mayUpdateNow, pagerStateOf } from './pagers-view.js';

/** Battery levels are not announced (only a change to low or offline is), so read them again. */
export const PAGER_REFRESH_MS = 60_000;

type Open =
  | { readonly kind: 'REGISTER' }
  | { readonly kind: 'GIVE' | 'ROTATE'; readonly pager: PagerView }
  | { readonly kind: 'TAKE_BACK'; readonly pager: PagerView; readonly wearer: string }
  | {
      readonly kind: 'CREDENTIAL';
      readonly pagerName: string;
      readonly credential: PagerCredentialResponse;
    };

/** The firmware this PC passes on to its pagers (PGR-011), above the list; nothing until there is some. */
function FirmwareNotice({ firmware }: { firmware: LiveData<PagerFirmwareResponse> }) {
  const t = useT();
  if (firmware.status === 'loading') return null;
  if (firmware.status === 'error') {
    return <p className="dashboard-section__hint">{t('pagers.update.loadFailed')}</p>;
  }
  const { firmware: served, incoming } = firmware.value;
  const lines = [
    served === null
      ? undefined
      : served.halted
        ? t('pagers.update.halted', { version: served.version })
        : t('pagers.update.served', { version: served.version }),
    incoming === null
      ? undefined
      : incoming.problem === null
        ? t('pagers.update.incoming', { version: incoming.version })
        : t('pagers.update.incomingProblem', {
            version: incoming.version,
            refused: String(incoming.problem.refused),
            message: incoming.problem.message,
          }),
  ].filter((line) => line !== undefined);
  if (lines.length === 0) return null;
  return (
    <div className="dashboard-section__hint" role="status">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

/**
 * The pagers (P4-02b, PGR-012 to PGR-014): register one by its serial, give it to someone or take
 * it back (at shift start, in a few seconds each), and issue a new credential. Each pager shows
 * whether it is connected, its battery against the restaurant's low level and who wears it. The
 * list follows pager changes made on any screen and the pagers' own state, and reads battery
 * levels again every minute. The firmware this PC passes on and each pager's update come with it,
 * with "Update now" for those who may install updates (PGR-011, UPD-004, P2-04b).
 */
export function PagersScreen() {
  const t = useT();
  const controller = useConsole();
  const { person } = useConsoleState();
  const canUpdate = person !== undefined && grantOf(person, 'UPDATE_INSTALL_NOW') !== 'DENY';
  const toast = useToast();
  const { data, reload } = useLive(
    async () => {
      const [list, staff] = await Promise.all([
        controller.api.listPagers(),
        controller.api.listStaff(),
      ]);
      return { ...list, people: staff.staff };
    },
    (type) => type === 'RestaurantChanged' || type === 'DeviceStatusChanged',
  );
  const { data: firmware, reload: reloadFirmware } = useLive(
    () => controller.api.getPagerFirmware(),
    (type) => type === 'RestaurantChanged' || type === 'DeviceStatusChanged',
  );
  useEffect(() => {
    const timer = setInterval(() => {
      reload();
      reloadFirmware();
    }, PAGER_REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [reload, reloadFirmware]);
  const [open, setOpen] = useState<Open | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const close = useCallback(() => {
    setOpen(undefined);
    setBusy(false);
    setError(undefined);
  }, []);

  /** Gives the pager to someone, or takes it back (null), at once (PGR-012). */
  const assign = async (pager: PagerView, person: StaffView | null) => {
    setBusy(true);
    setError(undefined);
    try {
      await controller.api.assignPager({
        params: { deviceId: pager.deviceId },
        body: { staffId: person?.id ?? null },
      });
      toast.show({
        title:
          person === null
            ? t('pagers.takenBack', { pager: pager.name })
            : t('pagers.given', { pager: pager.name, name: person.displayName }),
        tone: 'success',
      });
      close();
      reload();
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  /** UPD-004: offers the firmware to this pager outside the maintenance window. */
  const updateNow = async (pager: PagerView) => {
    try {
      await controller.api.updatePagerFirmwareNow({ params: { deviceId: pager.deviceId } });
      toast.show({
        title: t('pagers.update.requested', {
          pager: pager.name,
          version: firmware.status === 'ready' ? (firmware.value.firmware?.version ?? '') : '',
        }),
        tone: 'success',
      });
    } catch (failure) {
      toast.show({ title: messageOf(failure, t), tone: 'danger' });
    }
    reloadFirmware();
  };

  const rotate = async (pager: PagerView) => {
    setBusy(true);
    setError(undefined);
    try {
      const credential = await controller.api.rotatePagerCredential({
        params: { deviceId: pager.deviceId },
      });
      setBusy(false);
      setOpen({ kind: 'CREDENTIAL', pagerName: pager.name, credential });
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  let content: ReactNode;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('pagers.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else if (data.value.pagers.length === 0) {
    content = <EmptyState title={t('pagers.none')} />;
  } else {
    const names = new Map(data.value.people.map((person) => [person.id, person.displayName]));
    const served = firmware.status === 'ready' ? firmware.value.firmware : null;
    const updates = new Map(
      (firmware.status === 'ready' ? firmware.value.pagers : []).map((update) => [
        update.deviceId,
        update,
      ]),
    );
    content = (
      <ul className="staff-list" aria-label={t('pagers.title')}>
        {data.value.pagers.map((pager) => (
          <PagerRow
            key={pager.deviceId}
            pager={pager}
            wearer={pager.staffId === null ? undefined : names.get(pager.staffId)}
            lowBatteryPercent={data.value.lowBatteryPercent}
            firmwareVersion={served?.version}
            update={updates.get(pager.deviceId)}
            onUpdateNow={
              canUpdate && mayUpdateNow(served, updates.get(pager.deviceId))
                ? () => {
                    void updateNow(pager);
                  }
                : undefined
            }
            onGive={() => {
              setOpen({ kind: 'GIVE', pager });
            }}
            onTakeBack={(wearer) => {
              setOpen({ kind: 'TAKE_BACK', pager, wearer });
            }}
            onRotate={() => {
              setOpen({ kind: 'ROTATE', pager });
            }}
          />
        ))}
      </ul>
    );
  }

  const people = data.status === 'ready' ? data.value.people : [];
  return (
    <section className="dashboard-section" aria-labelledby="dashboard-pagers">
      <div className="staff-header">
        <h2 id="dashboard-pagers" className="dashboard-section__heading">
          {t('pagers.title')}
        </h2>
        <Button
          startIcon={<Icon name="plus" />}
          disabled={data.status !== 'ready'}
          onClick={() => {
            setOpen({ kind: 'REGISTER' });
          }}
        >
          {t('pagers.register')}
        </Button>
      </div>
      <p className="dashboard-section__hint">{t('pagers.intro')}</p>
      <FirmwareNotice firmware={firmware} />
      {content}
      {open?.kind === 'REGISTER' && data.status === 'ready' ? (
        <RegisterPagerDialog
          pagers={data.value.pagers}
          people={people}
          onRegistered={(pagerName, credential) => {
            toast.show({ title: t('pagers.registered', { pager: pagerName }), tone: 'success' });
            setOpen({ kind: 'CREDENTIAL', pagerName, credential });
            reload();
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'GIVE' ? (
        <GivePagerDialog
          pager={open.pager}
          people={people}
          busy={busy}
          error={error}
          onGive={(person) => {
            void assign(open.pager, person);
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'TAKE_BACK' ? (
        <ConfirmDialog
          open
          tone="primary"
          title={t('pagers.takeBackDialog.title', { pager: open.pager.name, name: open.wearer })}
          description={t('pagers.takeBackDialog.description')}
          confirmLabel={t('pagers.takeBackDialog.confirm')}
          cancelLabel={t('pagers.takeBackDialog.cancel')}
          busy={busy}
          onConfirm={() => {
            void assign(open.pager, null);
          }}
          onCancel={close}
        >
          {error === undefined ? null : (
            <p role="alert" className="console-notice console-notice--danger">
              {error}
            </p>
          )}
        </ConfirmDialog>
      ) : null}
      {open?.kind === 'ROTATE' ? (
        <ConfirmDialog
          open
          tone="danger"
          title={t('pagers.credentialDialog.confirmTitle', { pager: open.pager.name })}
          description={t('pagers.credentialDialog.confirmDescription', {
            pager: open.pager.name,
          })}
          confirmLabel={t('pagers.credentialDialog.confirm')}
          cancelLabel={t('pagers.credentialDialog.cancel')}
          busy={busy}
          onConfirm={() => {
            void rotate(open.pager);
          }}
          onCancel={close}
        >
          {error === undefined ? null : (
            <p role="alert" className="console-notice console-notice--danger">
              {error}
            </p>
          )}
        </ConfirmDialog>
      ) : null}
      {open?.kind === 'CREDENTIAL' ? (
        <PagerCredentialDialog
          pagerName={open.pagerName}
          credential={open.credential}
          onDone={close}
        />
      ) : null}
    </section>
  );
}

/** What a pager's firmware update says, in words; nothing when it runs the PC's firmware. */
function updateLines(
  t: ReturnType<typeof useT>,
  update: PagerFirmwarePagerView | undefined,
  version: string | undefined,
): string[] {
  if (update === undefined || version === undefined || update.status === 'UP_TO_DATE') return [];
  const line =
    update.status === 'UPDATING'
      ? t('pagers.update.updating', { version })
      : update.status === 'GAVE_UP'
        ? t('pagers.update.gaveUp', { version, rolledBack: String(update.rolledBack) })
        : t('pagers.update.waiting', { version, reason: update.waitFor ?? 'other' });
  return update.error === null
    ? [line]
    : [line, t('pagers.update.lastError', { error: update.error })];
}

/** One pager: its name and serial, its state in words and who wears it, with its actions. */
function PagerRow({
  pager,
  wearer,
  lowBatteryPercent,
  firmwareVersion,
  update,
  onGive,
  onTakeBack,
  onRotate,
  onUpdateNow,
}: {
  pager: PagerView;
  wearer: string | undefined;
  lowBatteryPercent: number;
  /** The firmware this PC passes on, if any (PGR-011). */
  firmwareVersion: string | undefined;
  update: PagerFirmwarePagerView | undefined;
  onGive: () => void;
  onTakeBack: (wearer: string) => void;
  onRotate: () => void;
  /** Only for someone who may install updates, when the pager may be updated now. */
  onUpdateNow: (() => void) | undefined;
}) {
  const t = useT();
  const state = pagerStateOf(pager);
  const battery = batteryOf(pager, lowBatteryPercent);
  const updates = updateLines(t, update, firmwareVersion);
  const details = [
    state.kind === 'CONNECTED'
      ? undefined
      : state.lastSeenAt === null
        ? t('pagers.neverSeen')
        : t('pagers.lastSeen', { time: timeOfDayOf(new Date(state.lastSeenAt)) }),
    pager.firmwareVersion === null
      ? undefined
      : t('pagers.firmware', { version: pager.firmwareVersion }),
  ].filter((detail) => detail !== undefined);
  return (
    <li className="staff-row">
      <div className="staff-row__who">
        <h3 className="staff-row__name">{pager.name}</h3>
        {pager.serial === null ? null : (
          <p className="staff-row__role">{t('pagers.serial', { serial: pager.serial })}</p>
        )}
        <p className="staff-row__states">
          {state.kind === 'CONNECTED' ? (
            <Badge tone="success">{t('pagers.connected')}</Badge>
          ) : (
            <Badge tone="warning" icon={<Icon name="offline" />}>
              {t('pagers.notConnected')}
            </Badge>
          )}
          {battery.kind === 'UNKNOWN' ? (
            <Badge tone="neutral">{t('pagers.batteryUnknown')}</Badge>
          ) : battery.kind === 'LOW' ? (
            <Badge tone="danger" icon={<Icon name="warning" />}>
              {t('pagers.batteryLow', { percent: battery.percent })}
            </Badge>
          ) : (
            <Badge tone="neutral">{t('pagers.battery', { percent: battery.percent })}</Badge>
          )}
        </p>
        <p className="pager-row__wearer">
          {wearer === undefined ? t('pagers.notWorn') : t('pagers.wornBy', { name: wearer })}
        </p>
        {details.length === 0 ? null : <p className="staff-row__contact">{details.join(' · ')}</p>}
        {updates.map((line) => (
          <p key={line} className="staff-row__contact">
            {line}
          </p>
        ))}
      </div>
      <div
        className="staff-row__actions"
        role="group"
        aria-label={t('pagers.actionsFor', { name: pager.name })}
      >
        <Button variant="secondary" onClick={onGive}>
          {wearer === undefined ? t('pagers.give') : t('pagers.giveOther')}
        </Button>
        {wearer === undefined ? null : (
          <Button
            variant="secondary"
            onClick={() => {
              onTakeBack(wearer);
            }}
          >
            {t('pagers.takeBack')}
          </Button>
        )}
        <Button variant="secondary" onClick={onRotate}>
          {t('pagers.newCredential')}
        </Button>
        {onUpdateNow === undefined ? null : (
          <Button
            variant="secondary"
            aria-label={t('pagers.update.nowFor', { pager: pager.name })}
            onClick={onUpdateNow}
          >
            {t('pagers.update.now')}
          </Button>
        )}
      </div>
    </li>
  );
}
