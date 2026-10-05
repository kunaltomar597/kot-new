import type { Translator } from '@rp/i18n';
import type {
  DeviceSession,
  DeviceSessionSnapshot,
  OtaSnapshot,
  OtaUpdater,
} from '@rp/mobile-core';
import { ThemeProvider, type UiStrings, UiStringsProvider } from '@rp/ui-native';
import {
  createContext,
  type ReactNode,
  use,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { AppState } from 'react-native';

interface Shell {
  readonly session: DeviceSession;
  readonly t: Translator;
  /** The app's over-the-air updates (P7-04e1); absent in tests and tools. */
  readonly updater: OtaUpdater | undefined;
}

const ShellContext = createContext<Shell | null>(null);

/** The words `@rp/ui-native` components need, from the catalogue (NFR-L02). */
export function uiStrings(t: Translator): UiStrings {
  return {
    pinPad: {
      label: t('ui.pinPad.label'),
      backspace: t('ui.pinPad.backspace'),
      clear: t('ui.pinPad.clear'),
      submit: t('ui.pinPad.submit'),
      progress: (entered, length) => t('ui.pinPad.progress', { entered, length }),
    },
    dialog: { close: t('ui.dialog.close') },
    toast: { dismiss: t('ui.toast.dismiss') },
  };
}

/** Gives the screens the device session, the catalogue, the app's updates and the theme. */
export function ShellProvider({
  session,
  translator,
  updater,
  children,
}: {
  session: DeviceSession;
  translator: Translator;
  updater?: OtaUpdater;
  children: ReactNode;
}) {
  const shell = useMemo(
    () => ({ session, t: translator, updater }),
    [session, translator, updater],
  );
  const strings = useMemo(() => uiStrings(translator), [translator]);
  return (
    <ShellContext value={shell}>
      <ThemeProvider>
        <UiStringsProvider strings={strings}>{children}</UiStringsProvider>
      </ThemeProvider>
    </ShellContext>
  );
}

function useShell(): Shell {
  const shell = use(ShellContext);
  if (shell === null) throw new Error('Wrap the app in <ShellProvider>.');
  return shell;
}

/** The device session's actions. */
export function useDeviceSession(): DeviceSession {
  return useShell().session;
}

/** The device session's state; re-renders when it changes. */
export function useSessionState(): DeviceSessionSnapshot {
  const { session } = useShell();
  return useSyncExternalStore(session.subscribe, session.getSnapshot);
}

/** The `t()` of the current catalogue. */
export function useT(): Translator {
  return useShell().t;
}

const noUpdates = () => () => undefined;
const noSnapshot = () => undefined;

/** What the app's over-the-air updates are doing (P7-04e1); undefined without an updater. */
export function useAppUpdate(): OtaSnapshot | undefined {
  const { updater } = useShell();
  return useSyncExternalStore(updater?.subscribe ?? noUpdates, updater?.getSnapshot ?? noSnapshot);
}

/**
 * Tells the app's updates whether the device is in use (UPD-001): `inUse` from the app (a person
 * signed in, guests at the table), and the app off the screen. A downloaded update restarts the
 * app only while it is free; once the screen is gone, it counts as in use.
 */
export function useAppUpdateWhenFree(inUse: boolean): void {
  const { updater } = useShell();
  const [onScreen, setOnScreen] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setOnScreen(state === 'active');
    });
    return () => {
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    updater?.setBusy(inUse || !onScreen);
    return () => {
      updater?.setBusy(true);
    };
  }, [updater, inUse, onScreen]);
}
