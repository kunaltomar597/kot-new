import type { Translator } from '@rp/i18n';
import type { DeviceSession } from '@rp/mobile-core';
import { PairingScreen, ShellProvider, useSessionState } from '@rp/mobile-shell';
import { ToastProvider } from '@rp/ui-native';
import { StatusBar } from 'expo-status-bar';
import { type TabletDevice, TabletHome } from './TabletHome';

function Screens({ device }: { device: TabletDevice }) {
  const { phase } = useSessionState();
  if (phase === 'loading') return null;
  if (phase === 'unpaired') return <PairingScreen />;
  return <TabletHome {...device} />;
}

/**
 * The table tablet: paired once to its table by a manager, then customer-facing with no staff
 * login, locked in kiosk mode (P2-01c, P3-01b; ordering arrives in P3-03).
 */
export function App({
  session,
  translator,
  device,
}: {
  session: DeviceSession;
  translator: Translator;
  device: TabletDevice;
}) {
  return (
    <ShellProvider session={session} translator={translator}>
      <ToastProvider>
        <StatusBar hidden />
        <Screens device={device} />
      </ToastProvider>
    </ShellProvider>
  );
}
