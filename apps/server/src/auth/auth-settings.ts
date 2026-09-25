import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service.js';

/**
 * The ⚙ settings of authentication (BRD §4, AUTH-001, AUTH-003, AUTH-005, AUTH-011), read from the
 * settings table with these defaults. P1-01 folds them into the full settings registry.
 */
export interface AuthSettings {
  /** AUTH-001: 4 by default, 6 when the owner requires it. */
  readonly pinLength: 4 | 6;
  /** AUTH-003: failures within the window that lock the login. */
  readonly lockoutMaxFailures: number;
  readonly lockoutWindowMinutes: number;
  readonly lockoutMinutes: number;
  /** SEC-009: login and override attempts per device per minute. */
  readonly attemptsPerMinutePerDevice: number;
  /** AUTH-005: at most 15 minutes. */
  readonly accessTokenMinutes: number;
  /** AUTH-005: POS and waiter devices. */
  readonly inactivityMinutes: number;
  /** Manager browsers (dashboard): longer, they are personal devices. */
  readonly managerBrowserInactivityMinutes: number;
  /** Absolute session length, whatever the activity (one long shift). */
  readonly sessionMaxHours: number;
  /** AUTH-006: how long a password + TOTP step-up stays valid. */
  readonly stepUpMinutes: number;
  /** AUTH-011: how long a manager's override approval can be used. */
  readonly overrideSeconds: number;
  /** AUTH-005: kitchen staff sign in individually instead of station mode. */
  readonly kitchenIndividualLogins: boolean;
}

export const AUTH_SETTING_DEFAULTS: AuthSettings = {
  pinLength: 4,
  lockoutMaxFailures: 5,
  lockoutWindowMinutes: 10,
  lockoutMinutes: 15,
  attemptsPerMinutePerDevice: 10,
  accessTokenMinutes: 15,
  inactivityMinutes: 10,
  managerBrowserInactivityMinutes: 30,
  sessionMaxHours: 16,
  stepUpMinutes: 5,
  overrideSeconds: 120,
  kitchenIndividualLogins: false,
};

const minutes = (max: number) => z.int().min(1).max(max);

const SCHEMAS: { readonly [K in keyof AuthSettings]: z.ZodType<AuthSettings[K]> } = {
  pinLength: z.union([z.literal(4), z.literal(6)]),
  lockoutMaxFailures: z.int().min(3).max(20),
  lockoutWindowMinutes: minutes(120),
  lockoutMinutes: minutes(24 * 60),
  attemptsPerMinutePerDevice: z.int().min(3).max(100),
  accessTokenMinutes: minutes(15),
  inactivityMinutes: minutes(240),
  managerBrowserInactivityMinutes: minutes(24 * 60),
  sessionMaxHours: z.int().min(1).max(24),
  stepUpMinutes: minutes(60),
  overrideSeconds: z.int().min(30).max(900),
  kitchenIndividualLogins: z.boolean(),
};

/** Settings-table key of each setting, e.g. `auth.lockoutMaxFailures`. */
export function authSettingKey(name: keyof AuthSettings): string {
  return `auth.${name}`;
}

/** Settings are read at most this often per restaurant (they change rarely; requests are many). */
const CACHE_MS = 30_000;

@Injectable()
export class AuthSettingsService {
  private readonly cache = new Map<string, { at: number; value: Promise<AuthSettings> }>();

  constructor(private readonly prisma: PrismaService) {}

  /** Current values; a missing or invalid stored value falls back to its default. */
  get(restaurantId: string): Promise<AuthSettings> {
    const now = Date.now();
    const cached = this.cache.get(restaurantId);
    if (cached !== undefined && now - cached.at < CACHE_MS) return cached.value;
    const value = this.load(restaurantId);
    value.catch(() => this.cache.delete(restaurantId));
    this.cache.set(restaurantId, { at: now, value });
    return value;
  }

  /** Forget cached values, e.g. after a setting was changed. */
  invalidate(): void {
    this.cache.clear();
  }

  private async load(restaurantId: string): Promise<AuthSettings> {
    const names = Object.keys(AUTH_SETTING_DEFAULTS) as (keyof AuthSettings)[];
    const rows = await this.prisma.setting.findMany({
      where: { restaurantId, key: { in: names.map(authSettingKey) } },
      select: { key: true, value: true },
    });
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    const result: Record<string, unknown> = { ...AUTH_SETTING_DEFAULTS };
    for (const name of names) {
      const parsed = SCHEMAS[name].safeParse(stored.get(authSettingKey(name)));
      if (parsed.success) result[name] = parsed.data;
    }
    return result as unknown as AuthSettings;
  }
}
