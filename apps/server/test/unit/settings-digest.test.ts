import { describe, expect, it } from 'vitest';
import { settingsDigest } from '../../src/settings/settings-digest.js';

describe('[UPD-010] the vendor settings digest', () => {
  it('matches the Control Plane’s, whatever the key order', () => {
    // The same vector is in apps/control-plane/test/integration/remote-settings.int.test.ts.
    expect(settingsDigest({ 'qr.pickupTimeoutSeconds': 90, 'features.aiMenuImport': false })).toBe(
      'a7a4e8534c8cde7a',
    );
  });
});
