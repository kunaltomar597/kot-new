import { NetworkKind } from '@rp/contracts';
import type {
  DeviceHealthReading,
  DeviceHealthSource,
  Kiosk,
  KioskMode,
  KioskState,
} from '@rp/mobile-core';

/** The native half, `RpKioskModule.kt`. */
export interface KioskNative {
  state(): { mode: string; deviceOwner: boolean; permitted: boolean };
  enter(): Promise<string>;
  exit(): Promise<string>;
  keepScreenOn(on: boolean): Promise<void>;
  health(): {
    batteryPercent: number | null;
    charging: boolean | null;
    network: string;
    rssi: number | null;
  };
  locateTone(durationMs: number): Promise<void>;
}

function modeOf(value: string): KioskMode {
  return value === 'LOCKED' || value === 'PINNED' ? value : 'NONE';
}

function within(value: number | null, min: number, max: number): number | null {
  return value === null || !Number.isInteger(value) || value < min || value > max ? null : value;
}

/**
 * The table tablet's kiosk and health on Android (P3-01b, TAB-001, TAB-015): lock-task mode, the
 * screen kept on, the battery, charging, network and Wi-Fi signal, and the "Locate" tone. Load it
 * once with `AndroidKiosk.load()`; reading the state and health is then synchronous.
 */
export class AndroidKiosk implements Kiosk, DeviceHealthSource {
  constructor(private readonly native: KioskNative) {}

  static async load(): Promise<AndroidKiosk> {
    const { requireNativeModule } = await import('expo');
    return new AndroidKiosk(requireNativeModule<KioskNative>('RpKiosk'));
  }

  state(): KioskState {
    const state = this.native.state();
    return { mode: modeOf(state.mode), deviceOwner: state.deviceOwner, permitted: state.permitted };
  }

  async enter(): Promise<KioskMode> {
    return modeOf(await this.native.enter());
  }

  async exit(): Promise<KioskMode> {
    return modeOf(await this.native.exit());
  }

  keepScreenOn(on: boolean): Promise<void> {
    return this.native.keepScreenOn(on);
  }

  locateTone(durationMs: number): Promise<void> {
    return this.native.locateTone(durationMs);
  }

  /** What the device says, kept to what the server takes (anything odd reads as unknown). */
  readHealth(): DeviceHealthReading {
    const health = this.native.health();
    return {
      batteryPercent: within(health.batteryPercent, 0, 100),
      charging: health.charging,
      network: NetworkKind.safeParse(health.network).data ?? 'OTHER',
      rssi: within(health.rssi, -127, 0),
    };
  }
}
