import type { Translator } from '@rp/i18n';
import type { ApkUpdater, DeviceSession, OtaUpdater } from '@rp/mobile-core';
import type { NotificationPermission } from '@rp/mobile-native';
import {
  LoginScreen,
  PairingScreen,
  ShellProvider,
  UpdateRequiredScreen,
  useAppUpdateWhenFree,
  useSessionState,
} from '@rp/mobile-shell';
import { ToastProvider } from '@rp/ui-native';
import { StatusBar } from 'expo-status-bar';
import { NotificationsProvider } from './notifications';
import { SignedIn } from './SignedIn';

/** Who may sign in on a waiter phone. */
const WAITER_APP_ROLES = ['WAITER', 'MANAGER', 'OWNER'] as const;

function Screens({ notifications }: { notifications: NotificationPermission | undefined }) {
  const { phase, person, clientTooOld } = useSessionState();
  // An over-the-air update restarts the app only while nobody is signed in on it (P7-04e1).
  useAppUpdateWhenFree(person !== undefined);
  if (phase === 'loading') return null;
  if (clientTooOld) return <UpdateRequiredScreen />;
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
 * the app (WTR-005, WTR-006). `updater` brings over-the-air updates (P7-04e1), `apkUpdater` new APKs from the PC
 * (P7-04e2).
 */
export function App({
  session,
  translator,
  notifications,
  updater,
  apkUpdater,
}: {
  session: DeviceSession;
  translator: Translator;
  notifications?: NotificationPermission;
  updater?: OtaUpdater;
  apkUpdater?: ApkUpdater;
}) {
  return (
    <ShellProvider
      session={session}
      translator={translator}
      {...(updater !== undefined && { updater })}
      {...(apkUpdater !== undefined && { apkUpdater })}
    >
      <ToastProvider>
        <StatusBar style="dark" />
        <Screens notifications={notifications} />
      </ToastProvider>
    </ShellProvider>
  );
}
