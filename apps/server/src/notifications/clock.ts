/** The time the notification engine works to; tests replace it to move time on (P2-03). */
export const NOTIFICATION_CLOCK = Symbol('NOTIFICATION_CLOCK');

export interface NotificationClock {
  now(): Date;
}

export const SYSTEM_CLOCK: NotificationClock = { now: () => new Date() };

/** How often the engine looks for repeats and escalations that are due. */
export const NOTIFICATION_OPTIONS = Symbol('NOTIFICATION_OPTIONS');

export interface NotificationOptions {
  /** 0 turns the ticker off (tests call `processDue` themselves). */
  readonly tickMs: number;
}

export const DEFAULT_NOTIFICATION_OPTIONS: NotificationOptions = { tickMs: 1_000 };
