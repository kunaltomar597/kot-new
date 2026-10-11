import type { StaffTile } from '@rp/contracts';
import { spacing } from '@rp/design-tokens';
import type { DeviceHealthSource, Kiosk, KioskMode } from '@rp/mobile-core';
import {
  ApkOffer,
  messageOf,
  Note,
  Screen,
  useDeviceSession,
  useLive,
  useSessionState,
  useT,
} from '@rp/mobile-shell';
import { Button, PinPad } from '@rp/ui-native';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { STAFF_TAPS, staffGesture } from './branding';

const NEVER = () => false;
/** Staff mode ends by itself, so a tablet is never left unlocked on a table. */
export const RELOCK_MINUTES = 10;

/**
 * The hidden corner (TAB-001): five quick taps in the top-left corner. Diners see nothing there,
 * and screen readers skip it.
 */
export function StaffCorner({ onOpen }: { onOpen: () => void }) {
  const [taps, setTaps] = useState<number[]>([]);
  return (
    <Pressable
      testID="staff-corner"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={styles.corner}
      onPress={() => {
        const next = staffGesture(taps, Date.now());
        if (next.length >= STAFF_TAPS) {
          setTaps([]);
          onOpen();
        } else {
          setTaps(next);
        }
      }}
    />
  );
}

/**
 * Leaving the kiosk (TAB-001): a manager or the Owner picks their name and enters their PIN, which
 * the server checks and audits; the tablet then leaves lock-task mode and shows what staff need
 * to look after it. It locks itself again after a while, or when they say so.
 */
export function StaffPanel({
  kiosk,
  health,
  tableLabel,
  onClose,
}: {
  kiosk: Kiosk;
  health: DeviceHealthSource;
  tableLabel: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const session = useDeviceSession();
  const { device, serverUrl } = useSessionState();
  const { data, reload } = useLive(() => session.staffTiles(), NEVER);
  const [manager, setManager] = useState<StaffTile | null>(null);
  const [mode, setMode] = useState<KioskMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode === null) return;
    const timer = setTimeout(onClose, RELOCK_MINUTES * 60_000);
    return () => {
      clearTimeout(timer);
    };
  }, [mode, onClose]);

  const check = (pin: string) => {
    if (manager === null) return;
    setBusy(true);
    setError(null);
    session.api
      .exitKiosk({ body: { staffId: manager.staffId, pin } })
      .then(() => kiosk.exit())
      .then(
        (left) => {
          setBusy(false);
          setMode(left);
        },
        (failure: unknown) => {
          setBusy(false);
          setError(messageOf(failure, t));
        },
      );
  };

  if (mode !== null) {
    const reading = health.readHealth();
    const state = kiosk.state();
    const lines = [
      device === undefined ? null : t('mobile.tablet.staff.device', { name: device.name }),
      tableLabel === null ? null : t('mobile.tablet.staff.tableLine', { table: tableLabel }),
      serverUrl === undefined ? null : t('mobile.tablet.staff.serverLine', { server: serverUrl }),
      device?.appVersion === null || device === undefined
        ? null
        : t('mobile.tablet.staff.versionLine', { version: device.appVersion }),
      reading.batteryPercent === null
        ? null
        : t('mobile.tablet.staff.batteryLine', {
            percent: reading.batteryPercent,
            charging: reading.charging === true ? 'yes' : 'no',
          }),
      t('mobile.tablet.staff.modeLine', { mode: state.mode }),
    ].filter((line): line is string => line !== null);
    return (
      <View style={styles.overlay} testID="staff-panel">
        <Screen title={t('mobile.tablet.staff.open')}>
          <Note tone="text">{t('mobile.tablet.staff.openHint', { minutes: RELOCK_MINUTES })}</Note>
          {lines.map((line) => (
            <Note key={line} tone="text">
              {line}
            </Note>
          ))}
          {!state.deviceOwner && <Note tone="danger">{t('mobile.tablet.staff.notOwner')}</Note>}
          {/* The PC's new version of the tablet app (P7-04e2): a device owner installs it by
              itself between guests; staff can install it now, or here on any tablet. */}
          <ApkOffer />
          <Button size="lg" fullWidth onPress={onClose}>
            {t('mobile.tablet.staff.lockAgain')}
          </Button>
        </Screen>
      </View>
    );
  }

  return (
    <View style={styles.overlay} testID="staff-panel">
      <Screen title={t('mobile.tablet.staff.title')}>
        {manager === null ? (
          <>
            <Note tone="text">{t('mobile.tablet.staff.chooseManager')}</Note>
            {data.status === 'loading' && <Note>{t('states.loading')}</Note>}
            {data.status === 'error' && (
              <>
                <Note tone="danger">{messageOf(data.error, t)}</Note>
                <Button variant="secondary" onPress={reload}>
                  {t('states.retry')}
                </Button>
              </>
            )}
            {data.status === 'ready' &&
              (() => {
                const managers = data.value.filter(
                  (tile) => tile.role === 'OWNER' || tile.role === 'MANAGER',
                );
                if (managers.length === 0) {
                  return <Note>{t('mobile.tablet.staff.noManagers')}</Note>;
                }
                return (
                  <View style={styles.tiles}>
                    {managers.map((tile) => (
                      <Button
                        key={tile.staffId}
                        testID={`manager-${tile.staffId}`}
                        variant="secondary"
                        size="lg"
                        fullWidth
                        accessibilityLabel={`${tile.displayName}, ${t(`roles.${tile.role}`)}`}
                        onPress={() => {
                          setManager(tile);
                        }}
                      >
                        {tile.displayName}
                      </Button>
                    ))}
                  </View>
                );
              })()}
          </>
        ) : (
          <PinPad
            label={t('mobile.tablet.staff.pinFor', { name: manager.displayName })}
            onComplete={check}
            error={error}
            busy={busy}
          />
        )}
        <Button
          variant="secondary"
          fullWidth
          onPress={() => {
            if (manager === null) onClose();
            else {
              setManager(null);
              setError(null);
            }
          }}
        >
          {t('mobile.tablet.staff.cancel')}
        </Button>
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  corner: { position: 'absolute', top: 0, left: 0, width: 80, height: 80, zIndex: 10 },
  overlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 20 },
  tiles: { gap: spacing[2] },
});
