import { describe, expect, it } from 'vitest';
import { scrubText, scrubValue } from '../src/scrub.js';

describe('[UPD-008] [NFR-O02] [SEC-015] scrubbing what leaves the restaurant', () => {
  it('removes keys, tokens and credentials', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ3YWl0ZXIifQ.c2lnbmF0dXJlLW9mLXRoZS10b2tlbg';
    const relay = 'Xq3vR9tLm2Kp8Wz5Yb7Nc4Jd6Hf1Gs0Ae2Bi9Cu3Dv7Ew';
    const text = [
      `token=${jwt}`,
      `Authorization: Bearer ${relay}`,
      'DATABASE_URL=postgres://rp_app:S3cret!pass@localhost:5432/rp',
      '{"pin":"4821","name":"Asha"}',
      'password = hunter2-long',
      `relay credential ${relay}`,
      '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIDhQ\n-----END PRIVATE KEY-----',
      `sha ${'ab'.repeat(32)}`,
    ].join('\n');
    const scrubbed = scrubText(text);
    for (const secret of [
      jwt,
      relay,
      'S3cret!pass',
      '4821',
      'hunter2-long',
      'MC4CAQAwBQYDK2VwBCIEIDhQ',
      'ab'.repeat(32),
    ]) {
      expect(scrubbed).not.toContain(secret);
    }
    expect(scrubbed).toContain('postgres://rp_app:[REDACTED]@localhost:5432/rp');
    expect(
      scrubText('saved to /var/folders/_5/zxg0zlw1175gdksjt6q7zfvr0000gq/T/rp-data/photos'),
    ).toBe('saved to /var/folders/_5/zxg0zlw1175gdksjt6q7zfvr0000gq/T/rp-data/photos');
    expect(scrubbed).toContain('"name":"Asha"');
  });

  it('removes email addresses and phone numbers, keeping ids and times', () => {
    const scrubbed = scrubText(
      'guest kiran@example.com called +91 98200 12345 and 9876543210 at 2026-10-02T10:15:00.000Z for order 0190a1b2-0000-7000-8000-000000000001 (₹1,250.00)',
    );
    expect(scrubbed).toBe(
      'guest [email] called [phone] and [phone] at 2026-10-02T10:15:00.000Z for order 0190a1b2-0000-7000-8000-000000000001 (₹1,250.00)',
    );
  });

  it('scrubs values to any depth and drops secret-named keys', () => {
    expect(
      scrubValue({
        name: 'Main PC',
        deviceToken: 'abc',
        nested: [{ password: 'x', note: 'mail me at a@b.co' }],
        count: 3,
        flag: null,
        credential: true,
        pin: 4821,
      }),
    ).toEqual({
      name: 'Main PC',
      deviceToken: '[REDACTED]',
      nested: [{ password: '[REDACTED]', note: 'mail me at [email]' }],
      count: 3,
      flag: null,
      credential: true,
      pin: '[REDACTED]',
    });
  });
});
