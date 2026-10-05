import { CLIENT_API_VERSION } from '@rp/contracts';
import { describe, expect, it } from 'vitest';
import {
  clientApiRange,
  clientIdentityOf,
  clientTooOld,
  compatibilityOf,
  SERVER_CLIENT_API,
} from '../../src/http/client-version.js';

const v = (major: number, minor: number) => ({ major, minor });

describe('[UPD-006] the server’s client API', () => {
  it('is the contracts’ version', () => {
    expect(clientApiRange().current).toBe(CLIENT_API_VERSION);
    expect(`${String(SERVER_CLIENT_API.major)}.${String(SERVER_CLIENT_API.minor)}`).toBe(
      CLIENT_API_VERSION,
    );
  });

  it('serves the minor before its own', () => {
    expect(clientApiRange(v(1, 4))).toEqual({ current: '1.4', oldest: '1.3' });
    expect(clientApiRange(v(1, 0))).toEqual({ current: '1.0', oldest: '1.0' });
  });

  it('judges what a device last said against a server', () => {
    const server = v(1, 4);
    expect(compatibilityOf('1.4', server)).toBe('CURRENT');
    expect(compatibilityOf('1.3', server)).toBe('PREVIOUS');
    expect(compatibilityOf('1.2', server)).toBe('TOO_OLD');
    expect(compatibilityOf('1.5', server)).toBe('NEWER');
    expect(compatibilityOf(null, server)).toBe('UNKNOWN');
    expect(compatibilityOf('garbage', server)).toBe('UNKNOWN');
  });

  it('reads the app’s identity from x-rp-client, and nothing else', () => {
    expect(clientIdentityOf({ headers: { 'x-rp-client': 'console/1.0.0 api/1.0' } })).toEqual({
      kind: 'console',
      version: '1.0.0',
      api: v(1, 0),
    });
    expect(clientIdentityOf({ headers: {} })).toBeUndefined();
    expect(clientIdentityOf({ headers: { 'x-rp-client': ['a', 'b'] } })).toBeUndefined();
  });

  it('refuses a too-old app with 426 and what it is', () => {
    const error = clientTooOld({ kind: 'waiter-app', version: '0.9.0', api: v(0, 9) });
    expect(error).toMatchObject({
      status: 426,
      code: 'CLIENT_TOO_OLD',
      details: { kind: 'waiter-app', appVersion: '0.9.0', clientApi: '0.9' },
    });
  });
});
