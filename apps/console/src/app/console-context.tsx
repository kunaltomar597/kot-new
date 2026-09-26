import { createContext, type ReactNode, use, useSyncExternalStore } from 'react';
import type { ConsoleController, ConsoleSnapshot } from './console-controller.js';

const ConsoleContext = createContext<ConsoleController | null>(null);

export function ConsoleProvider({
  controller,
  children,
}: {
  controller: ConsoleController;
  children: ReactNode;
}) {
  return <ConsoleContext value={controller}>{children}</ConsoleContext>;
}

export function useConsole(): ConsoleController {
  const controller = use(ConsoleContext);
  if (controller === null) throw new Error('Wrap the console in <ConsoleProvider>.');
  return controller;
}

/** The console state; the screen re-renders when it changes. */
export function useConsoleState(): ConsoleSnapshot {
  const controller = useConsole();
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot);
}
