import {
  type DeviceHealthSource,
  HealthReporter,
  type Kiosk,
  type KeyValueStore,
} from '@rp/mobile-core';
import { Note, Screen, useDeviceSession, useLive, useMenu, useT } from '@rp/mobile-shell';
import { ThemeProvider } from '@rp/ui-native';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { accentColorsOf } from './branding';
import { IdleScreen } from './IdleScreen';
import { OpenTableScreen } from './OpenTableScreen';
import { StaffCorner, StaffPanel } from './StaffPanel';
import { useTablet } from './use-tablet';

export { orderableCount } from './OpenTableScreen';

/** What the tablet needs from Android: lock-task mode and its health (P3-01b). */
export interface TabletDevice {
  readonly store: KeyValueStore;
  readonly kiosk: Kiosk;
  readonly health: DeviceHealthSource;
  readonly appVersion?: string;
}

const ignore = () => undefined;

/**
 * The paired tablet (TAB-001 to TAB-003, TAB-015): locked in kiosk mode with the screen on, its
 * health reported, in the restaurant's colours; the idle screen while its table is free and the
 * guests' screen while a session is open, with what guests left wiped when it closes. Staff leave
 * through the hidden corner with a manager's PIN.
 */
export function TabletHome({ store, kiosk, health, appVersion }: TabletDevice) {
  const session = useDeviceSession();
  const t = useT();
  const tablet = useTablet(store);
  const menu = useMenu();
  const { data: restaurant } = useLive(
    () => session.api.getRestaurant(),
    (type) => type === 'RestaurantChanged',
  );
  const [staff, setStaff] = useState(false);
  const closeStaff = useCallback(() => {
    setStaff(false);
  }, []);

  useEffect(() => {
    kiosk.keepScreenOn(true).catch(ignore);
  }, [kiosk]);
  useEffect(() => {
    // Locked again whenever staff mode ends (or the app starts).
    if (!staff) kiosk.enter().catch(ignore);
  }, [kiosk, staff]);
  useEffect(() => {
    const reporter = new HealthReporter({
      source: health,
      api: () => session.api,
      ...(appVersion !== undefined && { appVersion }),
    });
    reporter.start();
    return () => {
      reporter.stop();
    };
  }, [appVersion, health, session]);

  const profile = restaurant.status === 'ready' ? restaurant.value : null;
  const table = tablet.table;
  let content;
  if (tablet.status === 'unbound') {
    content = (
      <Screen title={t('mobile.tablet.unbound')}>
        <Note tone="text">{t('mobile.tablet.unboundHint')}</Note>
      </Screen>
    );
  } else if (table === undefined) {
    content = (
      <Screen>
        <Note tone={tablet.status === 'error' ? 'danger' : 'text'}>
          {t(tablet.status === 'error' ? 'mobile.tablet.cannotReach' : 'mobile.tablet.loading')}
        </Note>
      </Screen>
    );
  } else if (table.session === null) {
    content = <IdleScreen restaurant={profile} table={table} menu={menu} />;
  } else {
    content = (
      <OpenTableScreen
        key={`${table.session.id}:${String(tablet.guestEpoch)}`}
        restaurant={profile}
        table={table}
        menu={menu}
      />
    );
  }
  return (
    <ThemeProvider accent={accentColorsOf(profile?.accentColor)}>
      <View style={styles.fill}>
        {content}
        <StaffCorner
          onOpen={() => {
            setStaff(true);
          }}
        />
        {staff && (
          <StaffPanel
            kiosk={kiosk}
            health={health}
            tableLabel={table?.label ?? null}
            onClose={closeStaff}
          />
        )}
      </View>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
