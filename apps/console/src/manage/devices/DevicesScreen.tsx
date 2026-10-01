import type { DeviceView } from '@rp/contracts';
import { displayDateTime } from '@rp/domain';
import { Badge, Button, EmptyState, ErrorState, Icon, LoadingState, useToast } from '@rp/ui-web';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useConsole, useConsoleState } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import {
  MoveTabletDialog,
  PairDeviceDialog,
  RenameDeviceDialog,
  UnpairDeviceDialog,
} from './DeviceDialogs.js';
import { type Binding, bindingOf, groupDevices, type Names, namesOf } from './devices-view.js';

/** Connections and battery levels are not announced, so read them again. */
export const DEVICE_REFRESH_MS = 30_000;

type Open =
  | { readonly kind: 'PAIR' }
  | { readonly kind: 'RENAME' | 'MOVE' | 'UNPAIR'; readonly device: DeviceView };

/**
 * The paired devices (P4-02c, MGR-006): each screen, phone, tablet and pager with what it is bound
 * to, whether it is connected, its battery and versions and when it was last seen. A manager pairs
 * a new device, renames one, moves a table tablet to another table (AUTH-009) or unpairs one
 * (AUTH-008: it stops working at once). The list follows changes made on any screen and reads
 * connections again every half minute.
 */
export function DevicesScreen() {
  const t = useT();
  const controller = useConsole();
  const { device: thisDevice } = useConsoleState();
  const toast = useToast();
  const { data, reload } = useLive(
    async () => {
      const [list, floor, stations, staff] = await Promise.all([
        controller.api.listDevices(),
        controller.api.getFloor(),
        controller.api.listStations(),
        controller.api.listStaff(),
      ]);
      return { devices: list.devices, floor, stations: stations.stations, people: staff.staff };
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

  const close = useCallback(() => {
    setOpen(undefined);
    setBusy(false);
    setError(undefined);
  }, []);

  /** Runs one change, says what happened, and reads the list again. */
  const change = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      toast.show({ title: done, tone: 'success' });
      close();
      reload();
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
        title={t('devices.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const { groups, unpaired } = groupDevices(data.value.devices);
    const names = namesOf(data.value.floor, data.value.stations, data.value.people);
    content =
      groups.length === 0 && unpaired.length === 0 ? (
        <EmptyState title={t('devices.none')} />
      ) : (
        <>
          {groups.map((group) => (
            <section
              key={group.type}
              className="device-group"
              aria-labelledby={`devices-${group.type}`}
            >
              <h3 id={`devices-${group.type}`} className="device-group__heading">
                {t(`devices.type.${group.type}`)}
              </h3>
              <ul className="staff-list" aria-labelledby={`devices-${group.type}`}>
                {group.devices.map((device) => (
                  <DeviceRow
                    key={device.id}
                    device={device}
                    names={names}
                    isThisDevice={device.id === thisDevice?.id}
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
          ))}
          {unpaired.length === 0 ? null : (
            <details className="device-group device-group--unpaired">
              <summary className="device-group__heading">
                {t('devices.unpairedCount', { count: unpaired.length })}
              </summary>
              <p className="dashboard-section__hint">{t('devices.unpairedHint')}</p>
              <ul className="staff-list" aria-label={t('devices.unpairedTitle')}>
                {unpaired.map((device) => (
                  <DeviceRow key={device.id} device={device} names={names} isThisDevice={false} />
                ))}
              </ul>
            </details>
          )}
        </>
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
          onClose={() => {
            close();
            reload();
          }}
        />
      ) : null}
      {open?.kind === 'RENAME' ? (
        <RenameDeviceDialog
          device={open.device}
          busy={busy}
          error={error}
          onRename={(name) => {
            void change(
              () =>
                controller.api.renameDevice({
                  params: { deviceId: open.device.id },
                  body: { name },
                }),
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
          onMove={(tableId) => {
            const label = namesOf(data.value.floor, [], []).tables.get(tableId) ?? '';
            void change(
              () =>
                controller.api.bindTabletTable({
                  params: { deviceId: open.device.id },
                  body: { tableId },
                }),
              t('devices.moved', { name: open.device.name, table: label }),
            );
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'UNPAIR' ? (
        <UnpairDeviceDialog
          device={open.device}
          busy={busy}
          error={error}
          onUnpair={(reason) => {
            void change(
              () =>
                controller.api.revokeDevice({
                  params: { deviceId: open.device.id },
                  body: { reason },
                }),
              t('devices.unpaired', { name: open.device.name }),
            );
          }}
          onClose={close}
        />
      ) : null}
    </section>
  );
}

function bindingText(binding: Binding, t: ReturnType<typeof useT>): string | undefined {
  switch (binding.kind) {
    case 'TABLE':
      return t('devices.forTable', { table: binding.label });
    case 'STATION':
      return t('devices.forStation', { station: binding.name });
    case 'ALL_STATIONS':
      return t('devices.allStations');
    case 'PERSON':
      return t('devices.forPerson', { name: binding.name });
    case 'NONE':
      return undefined;
  }
}

/** One device: its name and type, its binding and state in words, and what can be done with it. */
function DeviceRow({
  device,
  names,
  isThisDevice,
  onRename,
  onMove,
  onUnpair,
}: {
  device: DeviceView;
  names: Names;
  isThisDevice: boolean;
  onRename?: () => void;
  onMove?: () => void;
  onUnpair?: () => void;
}) {
  const t = useT();
  const active = device.status === 'ACTIVE';
  const binding = bindingText(bindingOf(device, names), t);
  const details = [
    device.serial === null ? undefined : t('devices.serial', { serial: device.serial }),
    !active || device.network === null ? undefined : t(`devices.network.${device.network}`),
    device.appVersion === null
      ? undefined
      : t('devices.appVersion', { version: device.appVersion }),
    device.firmwareVersion === null
      ? undefined
      : t('devices.firmware', { version: device.firmwareVersion }),
    !active && device.revokedAt !== null
      ? t('devices.unpairedAt', displayDateTime(new Date(device.revokedAt)))
      : device.connected
        ? undefined
        : device.lastSeenAt === null
          ? t('devices.neverSeen')
          : t('devices.lastSeen', displayDateTime(new Date(device.lastSeenAt))),
  ].filter((detail) => detail !== undefined);
  return (
    <li className="staff-row" data-inactive={active ? undefined : ''}>
      <div className="staff-row__who">
        <h4 className="staff-row__name">
          {device.name}
          {isThisDevice ? <Badge tone="info">{t('devices.thisDevice')}</Badge> : null}
        </h4>
        <p className="staff-row__role">{t(`devices.typeOne.${device.type}`)}</p>
        {binding === undefined ? null : <p className="pager-row__wearer">{binding}</p>}
        <p className="staff-row__states">
          {!active ? (
            <Badge tone="neutral" icon={<Icon name="ban" />}>
              {t('devices.unpairedBadge')}
            </Badge>
          ) : device.connected ? (
            <Badge tone="success" icon={<Icon name="check" />}>
              {t('devices.connected')}
            </Badge>
          ) : (
            <Badge tone="warning" icon={<Icon name="offline" />}>
              {t('devices.notConnected')}
            </Badge>
          )}
          {active && device.batteryPercent !== null ? (
            <Badge tone="neutral">
              {device.charging === true
                ? t('devices.batteryCharging', { percent: device.batteryPercent })
                : t('devices.battery', { percent: device.batteryPercent })}
            </Badge>
          ) : null}
        </p>
        {details.length === 0 ? null : <p className="staff-row__contact">{details.join(' · ')}</p>}
      </div>
      {active ? (
        <div
          className="staff-row__actions"
          role="group"
          aria-label={t('devices.actionsFor', { name: device.name })}
        >
          <Button variant="secondary" onClick={onRename}>
            {t('devices.rename')}
          </Button>
          {device.type === 'TABLE_TABLET' ? (
            <Button variant="secondary" onClick={onMove}>
              {t('devices.moveTable')}
            </Button>
          ) : null}
          {isThisDevice ? null : (
            <Button variant="danger" onClick={onUnpair}>
              {t('devices.unpair')}
            </Button>
          )}
        </div>
      ) : null}
    </li>
  );
}
