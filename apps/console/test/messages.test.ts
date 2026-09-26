import { ApiRequestError, ApiUnavailableError, DeviceKeyUnavailableError } from '@rp/api-client';
import { createTranslator } from '@rp/i18n';
import { describe, expect, it } from 'vitest';
import { formatPairingCode, messageOf } from '../src/app/messages.js';

describe('[NFR-U04] messages and input the person can act on', () => {
  const t = createTranslator();

  it('shows the server’s own message, or what to check', () => {
    expect(messageOf(new ApiRequestError(401, { code: 'X', message: 'Try again.' }), t)).toBe(
      'Try again.',
    );
    expect(messageOf(new ApiUnavailableError('network'), t)).toBe(t('errors.network'));
    expect(messageOf(new ApiUnavailableError('timeout'), t)).toBe(t('errors.timeout'));
    expect(messageOf(new DeviceKeyUnavailableError(), t)).toBe(t('pairing.insecureContext'));
    expect(messageOf(new Error('boom'), t)).toBe(t('errors.generic'));
  });

  it('formats pairing codes however they are typed', () => {
    expect(formatPairingCode('abcd efgh')).toBe('ABCD-EFGH');
    expect(formatPairingCode('ab')).toBe('AB');
    expect(formatPairingCode('ABCD-EFGH-IJ')).toBe('ABCD-EFGH');
  });
});
