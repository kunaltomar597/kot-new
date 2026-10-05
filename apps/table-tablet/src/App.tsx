import type { Translator } from '@rp/i18n';
import type { DeviceSession, OtaUpdater } from '@rp/mobile-core';
import {
  PairingScreen,
  ShellProvider,
  UpdateRequiredScreen,
  useSessionState,
} from '@rp/mobile-shell';
import { ToastProvider } from '@rp/ui-native';
import { StatusBar } from 'expo-status-bar';
import { type TabletDevice, TabletHome } from './TabletHome';

function Screens({ device }: { device: TabletDevice }) {
  const { phase, clientTooOld } = useSessionState();
  if (phase === 'loading') return null;
  if (clientTooOld) return <UpdateRequiredScreen />;
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
  updater,
}: {
  session: DeviceSession;
  translator: Translator;
  device: TabletDevice;
  /** Over-the-air updates (P7-04e1). */
  updater?: OtaUpdater;
}) {
  return (
    <ShellProvider
      session={session}
      translator={translator}
      {...(updater !== undefined && { updater })}
    >
      <ToastProvider>
        <StatusBar hidden />
        <Screens device={device} />
      </ToastProvider>
    </ShellProvider>
  );
}
