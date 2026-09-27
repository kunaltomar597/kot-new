import type { Translator } from '@rp/i18n';
import type { DeviceSession } from '@rp/mobile-core';
import { LoginScreen, PairingScreen, ShellProvider, useSessionState } from '@rp/mobile-shell';
import { StatusBar } from 'expo-status-bar';
import { WaiterHome } from './WaiterHome';

/** Who may sign in on a waiter phone. */
const WAITER_APP_ROLES = ['WAITER', 'MANAGER', 'OWNER'] as const;

function Screens() {
  const { phase, person } = useSessionState();
  if (phase === 'loading') return null;
  if (phase === 'unpaired') return <PairingScreen />;
  if (person === undefined) return <LoginScreen roles={WAITER_APP_ROLES} />;
  return <WaiterHome />;
}

/** The waiter app: pair, sign in with a PIN, then the live tables (WTR-001). */
export function App({ session, translator }: { session: DeviceSession; translator: Translator }) {
  return (
    <ShellProvider session={session} translator={translator}>
      <StatusBar style="dark" />
      <Screens />
    </ShellProvider>
  );
}
