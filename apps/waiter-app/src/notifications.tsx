import { radius, spacing } from '@rp/design-tokens';
import type { Translator } from '@rp/i18n';
import type { AlertNotificationText, NotificationPermission } from '@rp/mobile-native';
import { useT } from '@rp/mobile-shell';
import { describeAlert } from '@rp/ordering';
import { Button, Glyph, toneColors, useTheme } from '@rp/ui-native';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';

/**
 * The words of the phone's notifications (P2-06b, NFR-L02): an alert says what the banner says
 * ("Table 5 · Food ready", then the dishes), and the service's notification whom the phone
 * listens for.
 */
export function alertNotificationText(t: Translator): AlertNotificationText {
  return {
    listening: (holder) => ({
      title: t('alerts.notification.listeningTitle', { name: holder.displayName }),
      text: t('alerts.notification.listeningText', { name: holder.displayName }),
    }),
    alert: (alert) => {
      const { title, detail } = describeAlert(alert, t);
      return { title, text: detail ?? '' };
    },
    acknowledge: t('alerts.acknowledge'),
    channels: {
      alerts: t('alerts.notification.alertsChannel'),
      listening: t('alerts.notification.listeningChannel'),
    },
  };
}

interface NotificationsState {
  /** Undefined until known, and on a device that shows no notifications (tests, the tablet). */
  readonly enabled: boolean | undefined;
  readonly openSettings: () => void;
}

const NotificationsContext = createContext<NotificationsState>({
  enabled: undefined,
  openSettings: () => undefined,
});

/**
 * Asks for notifications when someone signs in (Android 13 and later ask the person once or
 * twice), and checks again whenever the app comes back to the screen, as after the settings
 * (P2-06b, WTR-005). Mounted with the signed-in screens.
 */
export function NotificationsProvider({
  permission,
  children,
}: {
  permission: NotificationPermission | undefined;
  children: ReactNode;
}) {
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (permission === undefined) return undefined;
    let live = true;
    const settle = (check: Promise<boolean>) => {
      check
        .then((value) => {
          if (live) setEnabled(value);
        })
        .catch(() => {
          // A phone that cannot say leaves the hint off; the banner still shows every alert.
          if (live) setEnabled(undefined);
        });
    };
    settle(permission.request());
    const returned = AppState.addEventListener('change', (state) => {
      if (state === 'active') settle(permission.enabled());
    });
    return () => {
      live = false;
      returned.remove();
    };
  }, [permission]);
  const openSettings = () => {
    permission?.openSettings().catch(() => undefined);
  };
  return (
    <NotificationsContext.Provider value={{ enabled, openSettings }}>
      {children}
    </NotificationsContext.Provider>
  );
}

/**
 * Says when notifications are off, so a waiter knows alerts ring only while the app is open
 * (and on the pager), with a way to the settings to turn them on.
 */
export function NotificationsOff() {
  const { enabled, openSettings } = useContext(NotificationsContext);
  const t = useT();
  const { colors } = useTheme();
  if (enabled !== false) return null;
  const tone = toneColors(colors, 'warning');
  return (
    <View
      testID="notifications-off"
      style={[styles.card, { backgroundColor: tone.subtle, borderColor: tone.solid }]}
    >
      <View style={styles.row}>
        <Glyph name="warning" color={tone.text} />
        <Text accessibilityRole="alert" style={[styles.text, { color: colors.text }]}>
          {t('alerts.notification.off')}
        </Text>
      </View>
      <Button variant="secondary" onPress={openSettings} testID="notifications-turn-on">
        {t('alerts.notification.turnOn')}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.md, padding: spacing[3], gap: spacing[2] },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  text: { flex: 1 },
});
