import type { Translator } from '@rp/i18n';
import type { DeviceSession } from '@rp/mobile-core';
import type { NotificationPermission } from '@rp/mobile-native';
import { LoginScreen, PairingScreen, ShellProvider, useSessionState } from '@rp/mobile-shell';
import { ToastProvider } from '@rp/ui-native';
import { StatusBar } from 'expo-status-bar';
import { NotificationsProvider } from './notifications';
import { SignedIn } from './SignedIn';

/** Who may sign in on a waiter phone. */
const WAITER_APP_ROLES = ['WAITER', 'MANAGER', 'OWNER'] as const;

function Screens({ notifications }: { notifications: NotificationPermission | undefined }) {
  const { phase, person } = useSessionState();
  if (phase === 'loading') return null;
  if (phase === 'unpaired') return <PairingScreen />;
  if (person === undefined) return <LoginScreen roles={WAITER_APP_ROLES} />;
  // Notifications are asked for as someone signs in (P2-06b).
  return (
    <NotificationsProvider permission={notifications}>
      <SignedIn />
    </NotificationsProvider>
  );
}

/**
 * The waiter app: pair, sign in with a PIN, then "My tables" and each table's orders (WTR-001 to
 * WTR-003, WTR-012), with the waiter's alerts on every screen and, through `notifications`, outside
 * the app (WTR-005, WTR-006).
 */
export function App({
  session,
  translator,
  notifications,
}: {
  session: DeviceSession;
  translator: Translator;
  notifications?: NotificationPermission;
}) {
  return (
    <ShellProvider session={session} translator={translator}>
      <ToastProvider>
        <StatusBar style="dark" />
        <Screens notifications={notifications} />
      </ToastProvider>
    </ShellProvider>
  );
}
