/** The native half, `RpKioskModule.kt`. */
export interface ScreenGuardNative {
  secureScreen(on: boolean): Promise<void>;
}

/**
 * Blocks screenshots, screen recording and the recent apps' preview while a PIN is typed
 * (MOBILE-I4, SEC-010): Android's `FLAG_SECURE` on the app's window. Give it to `@rp/ui-native`'s
 * `setScreenGuard` at start; the PIN pad holds it while it shows.
 */
export class AndroidScreenGuard {
  constructor(private readonly native: ScreenGuardNative) {}

  static async load(): Promise<AndroidScreenGuard> {
    const { requireNativeModule } = await import('expo');
    return new AndroidScreenGuard(requireNativeModule<ScreenGuardNative>('RpKiosk'));
  }

  secure(on: boolean): Promise<void> {
    return this.native.secureScreen(on);
  }
}
