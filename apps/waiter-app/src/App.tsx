import type { Translator } from '@rp/i18n';
import type { DeviceSession } from '@rp/mobile-core';
import { LoginScreen, PairingScreen, ShellProvider, useSessionState } from '@rp/mobile-shell';
import { ToastProvider } from '@rp/ui-native';
import { StatusBar } from 'expo-status-bar';
import { TablesScreen } from './TablesScreen';

/** Who may sign in on a waiter phone. */
const WAITER_APP_ROLES = ['WAITER', 'MANAGER', 'OWNER'] as const;

function Screens() {
  const { phase, person } = useSessionState();
  if (phase === 'loading') return null;
  if (phase === 'unpaired') return <PairingScreen />;
  if (person === undefined) return <LoginScreen roles={WAITER_APP_ROLES} />;
  return <TablesScreen />;
}

/** The waiter app: pair, sign in with a PIN, then "My tables" (WTR-001, WTR-002). */
export function App({ session, translator }: { session: DeviceSession; translator: Translator }) {
  return (
    <ShellProvider session={session} translator={translator}>
      <ToastProvider>
        <StatusBar style="dark" />
        <Screens />
      </ToastProvider>
    </ShellProvider>
  );
}
