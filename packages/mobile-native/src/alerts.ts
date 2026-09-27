import type { AlertView } from '@rp/contracts';
import type { AlertHolder, AlertNotifier } from '@rp/mobile-core';

/** The service's notification and the channels, as `RpAlertsModule.kt` takes them. */
export interface ListeningNotice {
  readonly title: string;
  readonly text: string;
  readonly alertsChannel: string;
  readonly listeningChannel: string;
}

/** One alert's notification. `postedAt` is when it was raised, in epoch milliseconds. */
export interface AlertNotice {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly acknowledge: string;
  readonly postedAt: number;
}

/** The native half (`RpAlertsModule.kt`, `RpAlertService.kt`, `AlertNotifications.kt`). */
export interface AlertsNative {
  start(notice: ListeningNotice): Promise<void>;
  stop(): Promise<void>;
  announce(notice: AlertNotice): Promise<void>;
  dismiss(alertId: string): Promise<void>;
  notificationsEnabled(): Promise<boolean>;
  requestPermission(): Promise<boolean>;
  openSettings(): Promise<void>;
  addListener(
    eventName: 'onAcknowledge',
    listener: (event: { alertId: string }) => void,
  ): { remove(): void };
}

/** The words of the notifications, from the app's catalogue (NFR-L02). */
export interface AlertNotificationText {
  /** The notification that stays while the phone listens for the holder's alerts. */
  listening(holder: AlertHolder): { title: string; text: string };
  /** One alert's notification. */
  alert(alert: AlertView): { title: string; text: string };
  /** The notification's Acknowledge button. */
  readonly acknowledge: string;
  /** The channels' names in the app's notification settings. */
  readonly channels: { readonly alerts: string; readonly listening: string };
}

/** Whether notifications can show, for the screens: asked for at sign-in (P2-06b). */
export interface NotificationPermission {
  enabled(): Promise<boolean>;
  /** Asks Android 13 and later for notifications unless given; resolves whether they can show. */
  request(): Promise<boolean>;
  /** Opens the app's notification settings, where a person can turn them back on. */
  openSettings(): Promise<void>;
}

async function nativeModule(): Promise<AlertsNative> {
  const { requireNativeModule } = await import('expo');
  return requireNativeModule<AlertsNative>('RpAlerts');
}

export interface AndroidAlertNotifierOptions {
  readonly native?: () => Promise<AlertsNative>;
  /** Where a failure to listen for Acknowledge presses is reported. */
  readonly onError?: (error: unknown) => void;
}

/**
 * The waiter phone's alerts outside its screen (P2-06b, WTR-005): while the phone has a holder, a
 * foreground service keeps it listening with the screen off or the app closed, and each alert is a
 * notification that rings, vibrates, shows on the lock screen and has Acknowledge, posted again
 * on each repeat. With the app on screen the banner shows the alert and the phone only rings.
 */
export class AndroidAlertNotifier implements AlertNotifier, NotificationPermission {
  private readonly native: () => Promise<AlertsNative>;

  constructor(
    private readonly text: AlertNotificationText,
    private readonly options: AndroidAlertNotifierOptions = {},
  ) {
    this.native = options.native ?? nativeModule;
  }

  async start(holder: AlertHolder): Promise<void> {
    const { title, text } = this.text.listening(holder);
    await (
      await this.native()
    ).start({
      title,
      text,
      alertsChannel: this.text.channels.alerts,
      listeningChannel: this.text.channels.listening,
    });
  }

  async stop(): Promise<void> {
    await (await this.native()).stop();
  }

  async announce(alert: AlertView): Promise<void> {
    const { title, text } = this.text.alert(alert);
    const raised = Date.parse(alert.createdAt);
    await (
      await this.native()
    ).announce({
      id: alert.id,
      title,
      text,
      acknowledge: this.text.acknowledge,
      postedAt: Number.isNaN(raised) ? Date.now() : raised,
    });
  }

  async dismiss(alertId: string): Promise<void> {
    await (await this.native()).dismiss(alertId);
  }

  onAcknowledge(listener: (alertId: string) => void): () => void {
    let subscription: { remove(): void } | undefined;
    let removed = false;
    this.native()
      .then((native) => {
        if (removed) return;
        subscription = native.addListener('onAcknowledge', ({ alertId }) => {
          listener(alertId);
        });
      })
      .catch((error: unknown) => this.options.onError?.(error));
    return () => {
      removed = true;
      subscription?.remove();
    };
  }

  async enabled(): Promise<boolean> {
    return (await this.native()).notificationsEnabled();
  }

  async request(): Promise<boolean> {
    return (await this.native()).requestPermission();
  }

  async openSettings(): Promise<void> {
    await (await this.native()).openSettings();
  }
}

/** The headless task `RpAlertService` runs while the phone listens (`RpAlertService.kt`). */
export const ALERT_KEEP_ALIVE_TASK = 'RpAlertKeepAlive';

/** `AppRegistry.registerHeadlessTask` from React Native. */
export type RegisterHeadlessTask = (
  taskKey: string,
  taskProvider: () => (data: unknown) => Promise<void>,
) => void;

/** A promise that never settles: the keep-alive task ends only when the service ends it. */
const UNTIL_THE_SERVICE_STOPS = new Promise<never>(() => undefined);

/**
 * Registers the task that keeps JavaScript running while the alert service runs (P2-06b). While a
 * headless task runs, React Native keeps JavaScript timers going with no screen; this one never
 * finishes by itself. It first makes sure the device session is up: after Android restarted the
 * service in a new process, nothing else starts it. Call it where the app registers its root.
 */
export function registerAlertKeepAlive(
  register: RegisterHeadlessTask,
  ensureSession: () => Promise<unknown>,
  onError: (error: unknown) => void = () => undefined,
): void {
  register(ALERT_KEEP_ALIVE_TASK, () => async () => {
    try {
      await ensureSession();
    } catch (error) {
      onError(error);
    }
    await UNTIL_THE_SERVICE_STOPS;
  });
}
