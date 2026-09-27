import type { Translator } from '@rp/i18n';
import type { DeviceSession } from '@rp/mobile-core';
import { PairingScreen, ShellProvider, useSessionState } from '@rp/mobile-shell';
import { StatusBar } from 'expo-status-bar';
import { TabletHome } from './TabletHome';

function Screens() {
  const { phase } = useSessionState();
  if (phase === 'loading') return null;
  if (phase === 'unpaired') return <PairingScreen />;
  return <TabletHome />;
}

/**
 * The table tablet: paired once to its table by a manager, then customer-facing with no staff
 * login (P2-01c; ordering arrives in P3).
 */
export function App({ session, translator }: { session: DeviceSession; translator: Translator }) {
  return (
    <ShellProvider session={session} translator={translator}>
      <StatusBar hidden />
      <Screens />
    </ShellProvider>
  );
}
