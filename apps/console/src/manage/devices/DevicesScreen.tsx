import type { DeviceView } from '@rp/contracts';
import { Badge, Button, EmptyState, ErrorState, Icon, LoadingState, useToast } from '@rp/ui-web';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useConsole, useConsoleState } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { ReasonDialog } from '../../billing/ReasonDialog.js';
import { MoveTabletDialog, PairDeviceDialog, RenameDeviceDialog } from './DeviceDialogs.js';
import {
  type Binding,
  type BindingNames,
  bindingNamesOf,
  bindingOf,
  deviceBatteryOf,
  deviceGroups,
  lastSeenOf,
  shortDateOf,
} from './devices-view.js';

/**
 * Screens, phones and tablets do not announce each connection and disconnection, and battery
 * levels are not announced (only a change to low or offline is), so read them again this often.
 */
export const DEVICE_REFRESH_MS = 60_000;

type Open =
  | { readonly kind: 'PAIR' }
  | { readonly kind: 'RENAME' | 'MOVE' | 'UNPAIR'; readonly device: DeviceView };

/**
 * The Devices page (P4-02c, MGR-006): every paired device by type, with what it is bound to
 * (table, station or person), whether it is connected now, its battery, app or firmware version
 * and when it was last seen. A manager pairs a device (a one-time code and QR code), renames it,
 * moves a table tablet to another table (AUTH-009), asks it to show itself ("Locate") and unpairs
 * it with a reason (AUTH-008: it stops working at once). The list follows device changes made on
 * any screen and reads connection and battery states again every minute.
 */
export function DevicesScreen() {
  const t = useT();
  const controller = useConsole();
  const { device: thisDevice } = useConsoleState();
  const toast = useToast();
  const { data, reload } = useLive(
    async () => {
      // Names only label the bindings: the list still shows when one of them cannot be read.
      const [list, floor, stations, people] = await Promise.all([
        controller.api.listDevices(),
        controller.api.getFloor().catch(() => undefined),
        controller.api.listStations().then(
          (response) => response.stations,
          () => [],
        ),
        controller.api.listStaff().then(
          (response) => response.staff,
          () => [],
        ),
      ]);
      return { devices: list.devices, floor, stations, people };
    },
    (type) =>
      type === 'RestaurantChanged' || type === 'DeviceStatusChanged' || type === 'DeviceRevoked',
  );
  useEffect(() => {
    const timer = setInterval(reload, DEVICE_REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [reload]);
  const [open, setOpen] = useState<Open | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [locating, setLocating] = useState<string | undefined>();

  const close = useCallback(() => {
    setOpen(undefined);
    setBusy(false);
    setError(undefined);
  }, []);

  /** Runs a change from a dialog: says so, reads the list again and closes the dialog. */
  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      toast.show({ title: message, tone: 'success' });
      close();
      reload();
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  /** Asks the device to show itself (MGR-006 "Locate"); only a connected device can. */
  const locate = async (device: DeviceView) => {
    setLocating(device.id);
    try {
      await controller.api.locateDevice({ params: { deviceId: device.id } });
      toast.show({ title: t('devices.located', { name: device.name }), tone: 'success' });
    } catch (failure) {
      toast.show({ title: messageOf(failure, t), tone: 'danger' });
      reload();
    } finally {
      setLocating(undefined);
    }
  };

  let content: ReactNode;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('devices.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const groups = deviceGroups(data.value.devices);
    const names = bindingNamesOf(data.value.floor, data.value.stations, data.value.people);
    const now = new Date();
    content =
      groups.length === 0 ? (
        <EmptyState title={t('devices.none')} />
      ) : (
        groups.map((group) => {
          const headingId = `devices-${group.type}`;
          return (
            <section key={group.type} className="device-group" aria-labelledby={headingId}>
              <h3 id={headingId} className="device-group__heading">
                {t(`devices.group.${group.type}`)}
              </h3>
              {group.type === 'PAGER' ? (
                <p className="dashboard-section__hint">{t('devices.pagersElsewhere')}</p>
              ) : null}
              <ul className="staff-list" aria-labelledby={headingId}>
                {group.devices.map((device) => (
                  <DeviceRow
                    key={device.id}
                    device={device}
                    names={names}
                    now={now}
                    self={device.id === thisDevice?.id}
                    locating={locating === device.id}
                    onLocate={() => {
                      void locate(device);
                    }}
                    onRename={() => {
                      setOpen({ kind: 'RENAME', device });
                    }}
                    onMove={() => {
                      setOpen({ kind: 'MOVE', device });
                    }}
                    onUnpair={() => {
                      setOpen({ kind: 'UNPAIR', device });
                    }}
                  />
                ))}
              </ul>
            </section>
          );
        })
      );
  }

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-devices">
      <div className="staff-header">
        <h2 id="dashboard-devices" className="dashboard-section__heading">
          {t('devices.title')}
        </h2>
        <Button
          startIcon={<Icon name="plus" />}
          disabled={data.status !== 'ready'}
          onClick={() => {
            setOpen({ kind: 'PAIR' });
          }}
        >
          {t('devices.pair')}
        </Button>
      </div>
      <p className="dashboard-section__hint">{t('devices.intro')}</p>
      {content}
      {open?.kind === 'PAIR' && data.status === 'ready' ? (
        <PairDeviceDialog
          devices={data.value.devices}
          floor={data.value.floor}
          stations={data.value.stations}
          people={data.value.people}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'RENAME' ? (
        <RenameDeviceDialog
          device={open.device}
          busy={busy}
          error={error}
          onRename={(name) => {
            const { device } = open;
            void run(
              () =>
                controller.api.renameDevice({ params: { deviceId: device.id }, body: { name } }),
              t('devices.renamed', { name }),
            );
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'MOVE' && data.status === 'ready' ? (
        <MoveTabletDialog
          device={open.device}
          floor={data.value.floor}
          busy={busy}
          error={error}
          onMove={(table) => {
            const { device } = open;
            void run(
              () =>
                controller.api.bindTabletTable({
                  params: { deviceId: device.id },
                  body: { tableId: table.id },
                }),
              t('devices.moved', { name: device.name, table: table.label }),
            );
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'UNPAIR' ? (
        <ReasonDialog
          title={t('devices.unpairDialog.title', { name: open.device.name })}
          description={
            open.device.type === 'PAGER'
              ? t('devices.unpairDialog.pagerDescription')
              : t('devices.unpairDialog.description')
          }
          label={t('devices.unpairDialog.reason')}
          confirmLabel={t('devices.unpairDialog.confirm')}
          tone="danger"
          busy={busy}
          error={error}
          onConfirm={(reason) => {
            const { device } = open;
            void run(
              () =>
                controller.api.revokeDevice({ params: { deviceId: device.id }, body: { reason } }),
              t('devices.unpaired', { name: device.name }),
            );
          }}
          onClose={close}
        />
      ) : null}
    </section>
  );
}

/** One device: its name, binding and state in words, its details, and its actions. */
function DeviceRow({
  device,
  names,
  now,
  self,
  locating,
  onLocate,
  onRename,
  onMove,
  onUnpair,
}: {
  device: DeviceView;
  names: BindingNames;
  now: Date;
  /** The device this console runs on: it is not located or unpaired from itself. */
  self: boolean;
  locating: boolean;
  onLocate: () => void;
  onRename: () => void;
  onMove: () => void;
  onUnpair: () => void;
}) {
  const t = useT();
  const binding = bindingLine(bindingOf(device, names), t);
  const battery = deviceBatteryOf(device);
  const seen = lastSeenOf(device.lastSeenAt, now);
  const details = [
    device.online
      ? undefined
      : seen.kind === 'NEVER'
        ? t('devices.neverSeen')
        : seen.kind === 'TODAY'
          ? t('devices.lastSeenToday', { time: seen.time })
          : t('devices.lastSeenEarlier', {
              date: shortDateOf(seen.date, t.locale),
              time: seen.time,
            }),
    device.appVersion === null
      ? undefined
      : t('devices.appVersion', { version: device.appVersion }),
    device.firmwareVersion === null
      ? undefined
      : t('devices.firmware', { version: device.firmwareVersion }),
    device.serial === null ? undefined : t('devices.serial', { serial: device.serial }),
  ].filter((detail) => detail !== undefined);
  return (
    <li className="staff-row">
      <div className="staff-row__who">
        <h4 className="staff-row__name">
          {device.name}
          {self ? <Badge tone="info">{t('devices.thisDevice')}</Badge> : null}
        </h4>
        <p className="staff-row__role">{t(`devices.type.${device.type}`)}</p>
        {binding === undefined ? null : <p className="pager-row__wearer">{binding}</p>}
        <p className="staff-row__states">
          {device.online ? (
            <Badge tone="success">{t('devices.connected')}</Badge>
          ) : (
            <Badge tone="warning" icon={<Icon name="offline" />}>
              {t('devices.notConnected')}
            </Badge>
          )}
          {battery.kind === 'UNKNOWN' ? null : battery.kind === 'LOW' ? (
            <Badge tone="danger" icon={<Icon name="warning" />}>
              {t('devices.batteryLow', { percent: battery.percent })}
            </Badge>
          ) : (
            <Badge tone="neutral">{t('devices.battery', { percent: battery.percent })}</Badge>
          )}
        </p>
        {details.length === 0 ? null : <p className="staff-row__contact">{details.join(' · ')}</p>}
        {self ? <p className="staff-row__contact">{t('devices.ownDevice')}</p> : null}
      </div>
      <div
        className="staff-row__actions"
        role="group"
        aria-label={t('devices.actionsFor', { name: device.name })}
      >
        {device.online && !self ? (
          <Button variant="secondary" loading={locating} onClick={onLocate}>
            {t('devices.locate')}
          </Button>
        ) : null}
        <Button variant="secondary" onClick={onRename}>
          {t('devices.rename')}
        </Button>
        {device.type === 'TABLE_TABLET' ? (
          <Button variant="secondary" onClick={onMove}>
            {t('devices.move')}
          </Button>
        ) : null}
        {self ? null : (
          <Button variant="secondary" onClick={onUnpair}>
            {t('devices.unpair')}
          </Button>
        )}
      </div>
    </li>
  );
}

function bindingLine(binding: Binding, t: ReturnType<typeof useT>): string | undefined {
  const person = (name: string | undefined) => name ?? t('devices.personGone');
  switch (binding.kind) {
    case 'NONE':
      return undefined;
    case 'TABLE':
      return binding.table === undefined
        ? t('devices.tableGone')
        : t('devices.table', { table: binding.table });
    case 'STATION':
      return binding.station === undefined
        ? t('devices.stationGone')
        : t('devices.station', { station: binding.station });
    case 'ALL_STATIONS':
      return t('devices.allStations');
    case 'HOLDER':
      return t('devices.holder', { name: person(binding.name) });
    case 'NO_HOLDER':
      return t('devices.noHolder');
    case 'WEARER':
      return t('devices.wornBy', { name: person(binding.name) });
    case 'NOT_WORN':
      return t('devices.notWorn');
  }
}
