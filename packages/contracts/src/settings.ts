import { z } from 'zod';
import { Capability } from './auth.js';
import { Timestamp } from './common.js';

/**
 * The settings catalogue (P1-01a, MGR-007, UPD-010): every configurable value the BRD marks with
 * ⚙, with its validation, the BRD default, who may change it and why it exists. The server stores
 * only values that differ from the default (`settings` table, per restaurant); everything else
 * reads the default from here, so a new setting needs no migration.
 *
 * Kept elsewhere, not here: the business-day cut-off (restaurant profile, P1-01b), time-based
 * availability of an item (the item, P1-03), a station's print mode (the station, P1-06), which
 * items are "repeatable" for recommendations (the item, P1-03), per-event notification rules
 * (NTF-002, P2-03), the pilot length (a project plan, not software), Control Plane fleet alert
 * thresholds (the Control Plane, P7-03) and the whole-financial-year archive period (fixed by
 * law, DATA-008).
 */

/** RESTAURANT: changed on the dashboard (MGR-007). VENDOR: set by the vendor through the Control Plane and read-only here (UPD-010). */
export const SETTING_SCOPES = ['RESTAURANT', 'VENDOR'] as const;
export const SettingScope = z.enum(SETTING_SCOPES);
export type SettingScope = z.infer<typeof SettingScope>;

export interface SettingDefinition<
  Schema extends z.ZodType = z.ZodType,
  Key extends string = string,
> {
  /** Stable dotted key, `area.name`, as stored in the settings table. */
  readonly key: Key;
  readonly schema: Schema;
  /** The BRD default (or ours when the BRD gives none; the description says so). */
  readonly defaultValue: z.output<Schema>;
  readonly scope: SettingScope;
  /**
   * Who may change it. Capabilities that need the Owner's second factor (AUTH-006) need it here
   * too; VENDOR settings cannot be changed locally at all.
   */
  readonly capability: z.infer<typeof Capability>;
  readonly description: string;
  readonly requirements: readonly string[];
  /** Unit shown next to the value, when it has one. */
  readonly unit?:
    | 'minutes'
    | 'seconds'
    | 'hours'
    | 'days'
    | 'months'
    | 'percent'
    | 'basis points'
    | 'paise'
    | 'GB'
    | 'characters'
    | 'orders';
}

// `const Key` keeps each key a literal, so `SettingKey` and `SettingValue<K>` are precise.
function setting<Schema extends z.ZodType, const Key extends string>(
  definition: SettingDefinition<Schema, Key>,
): SettingDefinition<Schema, Key> {
  return definition;
}

const int = (min: number, max: number) => z.int().min(min).max(max);
/** `HH:MM`, 24-hour clock. */
export const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** A daily window; `end` before `start` means it runs past midnight. */
export const TimeWindow = z.strictObject({ start: TimeOfDay, end: TimeOfDay });
const PAGER_PATTERNS = ['ONE_LONG', 'TWO_SHORT', 'THREE_SHORT', 'LONG_SHORT'] as const;

export const SETTINGS = [
  // Authentication and devices (§4, AUTH, SEC-009)
  setting({
    key: 'auth.pinLength',
    schema: z.union([z.literal(4), z.literal(6)]),
    defaultValue: 4,
    scope: 'RESTAURANT',
    capability: 'STAFF_MANAGE',
    description: 'Digits in a staff PIN; the Owner may require 6.',
    requirements: ['AUTH-001'],
  }),
  setting({
    key: 'auth.lockoutMaxFailures',
    schema: int(3, 20),
    defaultValue: 5,
    scope: 'RESTAURANT',
    capability: 'STAFF_MANAGE',
    description: 'Wrong PINs within the window that lock the login.',
    requirements: ['AUTH-003'],
  }),
  setting({
    key: 'auth.lockoutWindowMinutes',
    schema: int(1, 120),
    defaultValue: 10,
    scope: 'RESTAURANT',
    capability: 'STAFF_MANAGE',
    description: 'Window in which wrong PINs are counted.',
    requirements: ['AUTH-003'],
    unit: 'minutes',
  }),
  setting({
    key: 'auth.lockoutMinutes',
    schema: int(1, 24 * 60),
    defaultValue: 15,
    scope: 'RESTAURANT',
    capability: 'STAFF_MANAGE',
    description: 'How long a locked login stays locked unless a manager unlocks it.',
    requirements: ['AUTH-003'],
    unit: 'minutes',
  }),
  setting({
    key: 'auth.attemptsPerMinutePerDevice',
    schema: int(3, 100),
    defaultValue: 10,
    scope: 'RESTAURANT',
    capability: 'STAFF_MANAGE',
    description: 'Login and override attempts allowed per device per minute.',
    requirements: ['AUTH-003', 'SEC-009'],
  }),
  setting({
    key: 'auth.accessTokenMinutes',
    schema: int(1, 15),
    defaultValue: 15,
    scope: 'RESTAURANT',
    capability: 'STAFF_MANAGE',
    description: 'Lifetime of an access token (at most 15 minutes).',
    requirements: ['AUTH-005'],
    unit: 'minutes',
  }),
  setting({
    key: 'auth.inactivityMinutes',
    schema: int(1, 240),
    defaultValue: 10,
    scope: 'RESTAURANT',
    capability: 'STAFF_MANAGE',
    description: 'Inactivity after which a POS or waiter device signs the person out.',
    requirements: ['AUTH-005'],
    unit: 'minutes',
  }),
  setting({
    key: 'auth.managerBrowserInactivityMinutes',
    schema: int(1, 24 * 60),
    defaultValue: 30,
    scope: 'RESTAURANT',
    capability: 'STAFF_MANAGE',
    description: 'Inactivity sign-out on manager browsers (personal devices; our default).',
    requirements: ['AUTH-005'],
    unit: 'minutes',
  }),
  setting({
    key: 'auth.sessionMaxHours',
    schema: int(1, 24),
    defaultValue: 16,
    scope: 'RESTAURANT',
    capability: 'STAFF_MANAGE',
    description: 'Longest a session lasts, however active (one long shift; our default).',
    requirements: ['AUTH-005'],
    unit: 'hours',
  }),
  setting({
    key: 'auth.stepUpMinutes',
    schema: int(1, 60),
    defaultValue: 5,
    scope: 'RESTAURANT',
    capability: 'STAFF_MANAGE',
    description:
      "How long the Owner's password and second factor stay fresh for Owner-only actions.",
    requirements: ['AUTH-006'],
    unit: 'minutes',
  }),
  setting({
    key: 'auth.overrideSeconds',
    schema: int(30, 900),
    defaultValue: 120,
    scope: 'RESTAURANT',
    capability: 'STAFF_MANAGE',
    description: "How long a manager's PIN approval can be used for the action it approved.",
    requirements: ['AUTH-011'],
    unit: 'seconds',
  }),
  setting({
    key: 'auth.kitchenIndividualLogins',
    schema: z.boolean(),
    defaultValue: false,
    scope: 'RESTAURANT',
    capability: 'STAFF_MANAGE',
    description: 'Kitchen staff sign in one by one instead of the screen acting for the station.',
    requirements: ['AUTH-005'],
  }),
  setting({
    key: 'auth.pairingCodeMinutes',
    schema: int(1, 60),
    defaultValue: 10,
    scope: 'RESTAURANT',
    capability: 'DEVICE_PAIR',
    description: 'How long a device pairing code can be used.',
    requirements: ['AUTH-007'],
    unit: 'minutes',
  }),
  setting({
    key: 'auth.deviceTokenMinutes',
    schema: int(5, 24 * 60),
    defaultValue: 60,
    scope: 'RESTAURANT',
    capability: 'DEVICE_PAIR',
    description: 'How long a device token lasts before the device signs a new challenge.',
    requirements: ['AUTH-007'],
    unit: 'minutes',
  }),
  setting({
    key: 'stock.kitchenMayManage',
    schema: z.boolean(),
    defaultValue: true,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'Kitchen staff may mark items out of stock and set stock counts.',
    requirements: ['MENU-006', 'OI-11'],
  }),
  setting({
    key: 'devices.lowBatteryAlertPercent',
    schema: int(5, 50),
    defaultValue: 20,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'Battery level at which a tablet or phone raises a low-battery alert.',
    requirements: ['TAB-015'],
    unit: 'percent',
  }),

  // Orders, billing and payments (ORD, BILL)
  setting({
    key: 'orders.specialInstructionsMaxLength',
    schema: int(20, 500),
    defaultValue: 140,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'Longest special instruction a guest or waiter may write on an item.',
    requirements: ['ORD-015'],
    unit: 'characters',
  }),
  setting({
    key: 'billing.priceMode',
    schema: z.enum(['TAX_EXCLUSIVE', 'TAX_INCLUSIVE']),
    defaultValue: 'TAX_EXCLUSIVE',
    scope: 'RESTAURANT',
    capability: 'TAX_AND_INVOICE_SETTINGS',
    description: 'Whether menu prices exclude or include GST (our default: exclusive).',
    requirements: ['BILL-004', 'ONB-004'],
  }),
  setting({
    key: 'billing.roundingUnitPaise',
    schema: z.union([z.literal(0), z.literal(10), z.literal(50), z.literal(100)]),
    defaultValue: 100,
    scope: 'RESTAURANT',
    capability: 'TAX_AND_INVOICE_SETTINGS',
    description:
      'Grand totals round to the nearest multiple of this (0: no rounding; our default: ₹1).',
    requirements: ['BILL-001', 'ONB-004'],
    unit: 'paise',
  }),
  setting({
    key: 'billing.cashierDiscountLimitBp',
    schema: int(0, 10_000),
    defaultValue: 1_000,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'Largest discount a cashier may give without a manager PIN.',
    requirements: ['BILL-005'],
    unit: 'basis points',
  }),
  setting({
    key: 'billing.serviceChargeEnabled',
    schema: z.boolean(),
    defaultValue: false,
    scope: 'RESTAURANT',
    // An invoice setting (ONB-004 step 3), so the Owner's (AUTH-006).
    capability: 'TAX_AND_INVOICE_SETTINGS',
    description: 'Add a voluntary service charge to bills (off by default; removable on request).',
    requirements: ['BILL-006', 'OI-12'],
  }),
  setting({
    key: 'billing.serviceChargeRateBp',
    schema: int(0, 2_000),
    defaultValue: 500,
    scope: 'RESTAURANT',
    capability: 'TAX_AND_INVOICE_SETTINGS',
    description:
      'Service charge rate on the taxable value of items when enabled (our default: 5 %).',
    requirements: ['BILL-006'],
    unit: 'basis points',
  }),
  setting({
    key: 'bills.headerLines',
    schema: z.array(z.string().trim().min(1).max(48)).max(4),
    defaultValue: [],
    scope: 'RESTAURANT',
    capability: 'TAX_AND_INVOICE_SETTINGS',
    description:
      'Lines printed on every bill under the restaurant particulars (48 characters each).',
    requirements: ['ONB-004', 'BILL-002'],
  }),
  setting({
    key: 'bills.footerLines',
    schema: z.array(z.string().trim().min(1).max(48)).max(4),
    defaultValue: [],
    scope: 'RESTAURANT',
    capability: 'TAX_AND_INVOICE_SETTINGS',
    description: 'Lines printed at the foot of every bill, e.g. a thank-you note.',
    requirements: ['ONB-004', 'BILL-002'],
  }),
  setting({
    key: 'bills.printerId',
    schema: z.uuid().nullable(),
    defaultValue: null,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description:
      'The printer bills print on, usually the one at the cash counter (none: choose each time).',
    requirements: ['BILL-014'],
  }),
  setting({
    key: 'payments.otherModes',
    schema: z.array(z.string().trim().min(1).max(30)).min(1).max(5),
    defaultValue: ['Other'],
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'Names of payment modes offered besides cash, card and UPI.',
    requirements: ['BILL-008'],
  }),
  setting({
    key: 'bills.hostedCopyDays',
    schema: int(1, 365),
    defaultValue: 30,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'How long a digital bill stays available on its link.',
    requirements: ['BILL-012'],
    unit: 'days',
  }),

  // Notifications, service requests and the kitchen (NTF, SVC, KDS)
  setting({
    key: 'notifications.escalationSeconds',
    schema: int(10, 600),
    defaultValue: 60,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'N: an alert not acknowledged within this time goes to the manager on duty.',
    requirements: ['NTF-002', 'NTF-005', 'OI-02'],
    unit: 'seconds',
  }),
  setting({
    key: 'notifications.repeatSeconds',
    schema: int(10, 600),
    defaultValue: 60,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'R: an unacknowledged alert or service request alerts again this often.',
    requirements: ['NTF-002', 'TAB-004', 'OI-02'],
    unit: 'seconds',
  }),
  setting({
    key: 'kds.ageAmberMinutes',
    schema: int(1, 120),
    defaultValue: 10,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'A ticket turns amber at this age.',
    requirements: ['KDS-004'],
    unit: 'minutes',
  }),
  setting({
    key: 'kds.ageRedMinutes',
    schema: int(2, 240),
    defaultValue: 20,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'A ticket turns red at this age (later than amber).',
    requirements: ['KDS-004'],
    unit: 'minutes',
  }),
  setting({
    key: 'kds.readyNotCollectedMinutes',
    schema: int(1, 60),
    defaultValue: 3,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'Ready items not picked up after this long make the ticket flash.',
    requirements: ['KDS-006'],
    unit: 'minutes',
  }),
  setting({
    key: 'kds.autoEscalateNotCollected',
    schema: z.boolean(),
    defaultValue: false,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'Alert the manager without the kitchen pressing "Notify manager".',
    requirements: ['KDS-006'],
  }),
  setting({
    key: 'kds.soundVolumePercent',
    schema: int(0, 100),
    defaultValue: 70,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'Volume of the new-ticket chime and the cancellation sound (our default).',
    requirements: ['KDS-009'],
    unit: 'percent',
  }),

  // Table tablets, pagers and the QR menu (TAB, PGR, QR)
  setting({
    key: 'tablet.idleShowsPromotions',
    schema: z.boolean(),
    defaultValue: true,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'The idle screen of a table tablet shows promotions.',
    requirements: ['TAB-003'],
  }),
  setting({
    key: 'pager.vibrationPatterns',
    schema: z.strictObject({
      READY: z.enum(PAGER_PATTERNS),
      SERVICE_REQUEST: z.enum(PAGER_PATTERNS),
      MANAGER: z.enum(PAGER_PATTERNS),
    }),
    defaultValue: { READY: 'ONE_LONG', SERVICE_REQUEST: 'TWO_SHORT', MANAGER: 'THREE_SHORT' },
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'How the pager vibrates for each kind of alert.',
    requirements: ['PGR-006'],
  }),
  setting({
    key: 'pager.lowBatteryPercent',
    schema: int(5, 50),
    defaultValue: 15,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'Battery level at which a pager alerts its wearer and the manager.',
    requirements: ['PGR-013'],
    unit: 'percent',
  }),
  setting({
    key: 'pager.heartbeatSeconds',
    schema: int(10, 300),
    defaultValue: 30,
    scope: 'VENDOR',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'How often a pager reports battery and signal; tuned with battery life (PGR-002).',
    requirements: ['PGR-007'],
    unit: 'seconds',
  }),
  setting({
    key: 'qr.submissionsPerWindow',
    schema: int(1, 50),
    defaultValue: 5,
    scope: 'VENDOR',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'QR orders allowed per table and per browser in the rate-limit window.',
    requirements: ['QR-006'],
    unit: 'orders',
  }),
  setting({
    key: 'qr.rateLimitWindowMinutes',
    schema: int(1, 120),
    defaultValue: 10,
    scope: 'VENDOR',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'Window of the QR order rate limit.',
    requirements: ['QR-006'],
    unit: 'minutes',
  }),
  setting({
    key: 'qr.pickupTimeoutSeconds',
    schema: int(15, 600),
    defaultValue: 60,
    scope: 'VENDOR',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'T: a QR order the restaurant has not picked up by then expires.',
    requirements: ['QR-007'],
    unit: 'seconds',
  }),
  setting({
    key: 'qr.presenceIntervalSeconds',
    schema: int(5, 300),
    defaultValue: 30,
    scope: 'VENDOR',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'How often the local server tells the QR relay it is present.',
    requirements: ['QR-008'],
    unit: 'seconds',
  }),
  setting({
    key: 'qr.readOnlyAfterSeconds',
    schema: int(30, 1_800),
    defaultValue: 120,
    scope: 'VENDOR',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'Without a presence signal for this long, the QR menu becomes read-only.',
    requirements: ['QR-008'],
    unit: 'seconds',
  }),

  // Recommendations (REC). Rates are basis points, never fractions.
  setting({
    key: 'reco.learningWindowDays',
    schema: int(7, 365),
    defaultValue: 90,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'Orders the "frequently ordered together" rules learn from.',
    requirements: ['REC-003'],
    unit: 'days',
  }),
  setting({
    key: 'reco.minSupportBp',
    schema: int(1, 10_000),
    defaultValue: 50,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description:
      'Minimum share of orders containing a pair for a learned rule (our default: 0.5 %).',
    requirements: ['REC-003'],
    unit: 'basis points',
  }),
  setting({
    key: 'reco.minConfidenceBp',
    schema: int(1, 10_000),
    defaultValue: 2_000,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'Minimum confidence of a learned rule (our default: 20 %).',
    requirements: ['REC-003'],
    unit: 'basis points',
  }),
  setting({
    key: 'reco.minLiftPercent',
    schema: int(100, 1_000),
    defaultValue: 120,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'Minimum lift of a learned rule, in percent (120 = 1.2×; our default).',
    requirements: ['REC-003'],
    unit: 'percent',
  }),
  setting({
    key: 'reco.minOrders',
    schema: int(50, 100_000),
    defaultValue: 300,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'Orders needed before learned rules are used.',
    requirements: ['REC-003'],
    unit: 'orders',
  }),
  setting({
    key: 'reco.bestSellerDays',
    schema: int(1, 365),
    defaultValue: 30,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'Days of orders that rank best sellers.',
    requirements: ['REC-004'],
    unit: 'days',
  }),
  setting({
    key: 'reco.dayparts',
    schema: z.strictObject({
      BREAKFAST: TimeWindow,
      LUNCH: TimeWindow,
      EVENING: TimeWindow,
      DINNER: TimeWindow,
    }),
    defaultValue: {
      BREAKFAST: { start: '07:00', end: '11:00' },
      LUNCH: { start: '11:00', end: '16:00' },
      EVENING: { start: '16:00', end: '19:00' },
      DINNER: { start: '19:00', end: '04:00' },
    },
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'Time-of-day windows best sellers are counted in (our defaults).',
    requirements: ['REC-004'],
  }),
  setting({
    key: 'reco.courseSequence',
    schema: z.array(z.string().trim().min(1).max(30)).min(1).max(12),
    defaultValue: ['Starters', 'Mains', 'Breads', 'Desserts', 'Beverages'],
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description:
      'Course order recommendations favour next (menu categories are tagged with a course).',
    requirements: ['REC-005'],
  }),

  // Audit, storage, backups and retention (AUD, DATA, §9.3)
  setting({
    key: 'audit.dailyReportEnabled',
    schema: z.boolean(),
    defaultValue: true,
    scope: 'RESTAURANT',
    capability: 'DATA_ADMIN',
    description: 'Send the Owner a daily suspicious-activity report.',
    requirements: ['AUD-006'],
  }),
  setting({
    key: 'audit.discountFlagBp',
    schema: int(0, 10_000),
    defaultValue: 2_000,
    scope: 'RESTAURANT',
    capability: 'DATA_ADMIN',
    description: 'Discounts above this rate appear in the daily report (our default: 20 %).',
    requirements: ['AUD-006'],
    unit: 'basis points',
  }),
  setting({
    key: 'audit.cashVarianceFlagPaise',
    schema: int(0, 10_000_000),
    defaultValue: 20_000,
    scope: 'RESTAURANT',
    capability: 'DATA_ADMIN',
    description: 'Cash variances above this appear in the daily report (our default: ₹200).',
    requirements: ['AUD-006'],
    unit: 'paise',
  }),
  setting({
    key: 'backups.walMode',
    schema: z.enum(['CONTINUOUS', 'HOURLY']),
    defaultValue: 'CONTINUOUS',
    scope: 'RESTAURANT',
    capability: 'DATA_ADMIN',
    description: 'Incremental backup of the database log: continuous or hourly.',
    requirements: ['DATA-002'],
  }),
  setting({
    key: 'backups.secondLocation',
    schema: z.string().trim().min(1).max(260).nullable(),
    defaultValue: null,
    scope: 'RESTAURANT',
    capability: 'DATA_ADMIN',
    description: 'Folder on a second disk, USB drive or NAS for the nightly full backup.',
    requirements: ['DATA-002'],
  }),
  setting({
    key: 'backups.keepDaily',
    schema: int(1, 90),
    defaultValue: 14,
    scope: 'RESTAURANT',
    capability: 'DATA_ADMIN',
    description: 'Daily backups kept.',
    requirements: ['DATA-002'],
  }),
  setting({
    key: 'backups.keepWeekly',
    schema: int(0, 104),
    defaultValue: 8,
    scope: 'RESTAURANT',
    capability: 'DATA_ADMIN',
    description: 'Weekly backups kept.',
    requirements: ['DATA-002'],
  }),
  setting({
    key: 'backups.cloudEnabled',
    schema: z.boolean(),
    defaultValue: true,
    scope: 'RESTAURANT',
    capability: 'DATA_ADMIN',
    description: 'Upload an encrypted backup to the cloud every night (the Owner may opt out).',
    requirements: ['DATA-003'],
  }),
  setting({
    key: 'storage.warnPercent',
    schema: int(50, 99),
    defaultValue: 80,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'Data-drive use that raises a warning.',
    requirements: ['DATA-006'],
    unit: 'percent',
  }),
  setting({
    key: 'storage.criticalPercent',
    schema: int(51, 100),
    defaultValue: 90,
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'Data-drive use that raises a critical alert (above the warning).',
    requirements: ['DATA-006'],
    unit: 'percent',
  }),
  setting({
    key: 'retention.operationalDays',
    schema: int(7, 3_650),
    defaultValue: 90,
    scope: 'RESTAURANT',
    capability: 'DATA_ADMIN',
    description:
      'Notifications, heartbeats, debug logs and temporary files are removed after this.',
    requirements: ['DATA-007'],
    unit: 'days',
  }),
  setting({
    key: 'retention.dinerContactMonths',
    schema: int(1, 120),
    defaultValue: 24,
    scope: 'RESTAURANT',
    capability: 'DATA_ADMIN',
    description: "A diner's contact details are anonymised after this long without a visit.",
    requirements: ['DATA-011'],
    unit: 'months',
  }),
  setting({
    key: 'retention.feedbackMonths',
    schema: int(1, 120),
    defaultValue: 24,
    scope: 'RESTAURANT',
    capability: 'DATA_ADMIN',
    description: 'Feedback is anonymised after this long.',
    requirements: ['DATA-011'],
    unit: 'months',
  }),

  // Updates, licence and the vendor link (UPD, LIC, VCP, ONB)
  setting({
    key: 'updates.maintenanceWindow',
    schema: TimeWindow,
    defaultValue: { start: '03:00', end: '06:00' },
    scope: 'RESTAURANT',
    capability: 'UPDATE_INSTALL_NOW',
    description: 'Updates install only in this window, unless a manager presses "Install now".',
    requirements: ['UPD-004'],
  }),
  setting({
    key: 'licence.validityDays',
    schema: int(1, 365),
    defaultValue: 30,
    scope: 'VENDOR',
    capability: 'LICENSE_MANAGE',
    description: 'A licence is valid this long from issue and renewed while online.',
    requirements: ['LIC-002'],
    unit: 'days',
  }),
  setting({
    key: 'licence.overdueToGraceDays',
    schema: int(0, 90),
    defaultValue: 15,
    scope: 'VENDOR',
    capability: 'LICENSE_MANAGE',
    description:
      'N: an overdue invoice moves the licence to grace after this long (subscription agreement).',
    requirements: ['LIC-005'],
    unit: 'days',
  }),
  setting({
    key: 'licence.graceDays',
    schema: int(1, 60),
    defaultValue: 7,
    scope: 'VENDOR',
    capability: 'LICENSE_MANAGE',
    description: 'Days of grace, shown on every staff screen, before the licence is restricted.',
    requirements: ['LIC-005'],
    unit: 'days',
  }),
  setting({
    key: 'controlPlane.heartbeatSeconds',
    schema: int(60, 3_600),
    defaultValue: 300,
    scope: 'VENDOR',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'How often this PC reports to the vendor (each answer sets it).',
    requirements: ['VCP-005'],
    unit: 'seconds',
  }),
  setting({
    key: 'onboarding.minFreeDiskGb',
    schema: int(5, 1_000),
    defaultValue: 20,
    scope: 'VENDOR',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'Free space the installer requires on the data drive.',
    requirements: ['ONB-002'],
    unit: 'GB',
  }),

  // Formats (NFR-L03)
  setting({
    key: 'ui.timeFormat',
    schema: z.enum(['12h', '24h']),
    defaultValue: '12h',
    scope: 'RESTAURANT',
    capability: 'OPERATIONS_CONFIGURE',
    description: 'Clock format on every screen, bill and report (our default: 12-hour).',
    requirements: ['NFR-L03'],
  }),
] as const;

export type SettingKey = (typeof SETTINGS)[number]['key'];

/** The value type of a setting, by key. */
export type SettingValue<K extends SettingKey> = z.output<
  Extract<(typeof SETTINGS)[number], { readonly key: K }>['schema']
>;

export const SETTING_KEYS = SETTINGS.map((definition) => definition.key) as readonly SettingKey[];

const BY_KEY = new Map<string, SettingDefinition>(
  SETTINGS.map((definition) => [definition.key, definition as SettingDefinition]),
);

/** The definition of a setting, or undefined for an unknown key. */
export function settingDefinition(key: string): SettingDefinition | undefined {
  return BY_KEY.get(key);
}

/**
 * Rules between settings, checked when one of them changes. Returns what is wrong, if anything.
 */
export function crossSettingProblems(values: Readonly<Record<string, unknown>>): string[] {
  const problems: string[] = [];
  const amber = values['kds.ageAmberMinutes'];
  const red = values['kds.ageRedMinutes'];
  if (typeof amber === 'number' && typeof red === 'number' && red <= amber) {
    problems.push('The red age must be later than the amber age.');
  }
  const warn = values['storage.warnPercent'];
  const critical = values['storage.criticalPercent'];
  if (typeof warn === 'number' && typeof critical === 'number' && critical <= warn) {
    problems.push('The critical storage level must be above the warning level.');
  }
  return problems;
}

/** One setting as the dashboard shows it (MGR-007, UPD-010). */
export const SettingView = z.object({
  key: z.string(),
  value: z.unknown(),
  defaultValue: z.unknown(),
  isDefault: z.boolean(),
  scope: SettingScope,
  capability: Capability,
  /** Whether the person asking may change it now (vendor settings never; AUTH-006 aside). */
  editable: z.boolean(),
  description: z.string(),
  requirements: z.array(z.string()),
  unit: z.string().optional(),
  updatedAt: Timestamp.nullable(),
});
export type SettingView = z.infer<typeof SettingView>;

export const SettingsResponse = z.object({ settings: z.array(SettingView) });
export type SettingsResponse = z.infer<typeof SettingsResponse>;

/** Changes one setting; the value is checked against the catalogue (SEC-004). */
export const UpdateSettingRequest = z.strictObject({
  value: z.unknown(),
  /** Why, for the audit log (AUD-001). */
  reason: z.string().trim().min(1).max(200).optional(),
});
export type UpdateSettingRequest = z.infer<typeof UpdateSettingRequest>;

export const SettingKeyParams = z.strictObject({
  key: z.string().regex(/^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/),
});
