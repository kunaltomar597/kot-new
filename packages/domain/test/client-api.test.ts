import { describe, expect, it } from 'vitest';
import {
  buildVersionMatrix,
  clientCompatibility,
  compareClientApi,
  firstReleaseSpeaking,
  formatClientApiVersion,
  formatClientIdentity,
  isClientServed,
  oldestServedClientApi,
  parseClientApiVersion,
  parseClientIdentity,
} from '../src/client-api.js';

const v = (text: string) => {
  const parsed = parseClientApiVersion(text);
  if (parsed === undefined) throw new Error(text);
  return parsed;
};

describe('[UPD-006] the client API version', () => {
  it('reads and writes major.minor', () => {
    expect(parseClientApiVersion('1.4')).toEqual({ major: 1, minor: 4 });
    expect(parseClientApiVersion('0.0')).toEqual({ major: 0, minor: 0 });
    expect(formatClientApiVersion({ major: 2, minor: 10 })).toBe('2.10');
    for (const bad of ['1', '1.4.0', 'v1.4', '01.4', '1.04', '1.', '.4', '1.4 ', '1000.1', '']) {
      expect(parseClientApiVersion(bad), bad).toBeUndefined();
    }
  });

  it('orders by major, then minor', () => {
    expect(compareClientApi(v('1.4'), v('1.10'))).toBeLessThan(0);
    expect(compareClientApi(v('2.0'), v('1.10'))).toBeGreaterThan(0);
    expect(compareClientApi(v('1.4'), v('1.4'))).toBe(0);
  });

  it('serves the minor before the current one, and only itself at minor 0', () => {
    expect(oldestServedClientApi(v('1.4'))).toEqual(v('1.3'));
    expect(oldestServedClientApi(v('1.0'))).toEqual(v('1.0'));
    expect(oldestServedClientApi(v('2.0'))).toEqual(v('2.0'));
  });
});

describe('[UPD-006] N-1: which apps the server serves', () => {
  const server = v('1.4');

  it('serves its own minor and the one before it', () => {
    expect(clientCompatibility(server, v('1.4'))).toBe('CURRENT');
    expect(clientCompatibility(server, v('1.3'))).toBe('PREVIOUS');
    expect(isClientServed(server, v('1.3'))).toBe(true);
  });

  it('refuses an app two minors behind, or from an older major', () => {
    expect(clientCompatibility(server, v('1.2'))).toBe('TOO_OLD');
    expect(clientCompatibility(server, v('0.9'))).toBe('TOO_OLD');
    expect(clientCompatibility(v('2.0'), v('1.9'))).toBe('TOO_OLD');
    expect(isClientServed(server, v('1.2'))).toBe(false);
  });

  it('serves an app newer than the server (it updated first)', () => {
    expect(clientCompatibility(server, v('1.5'))).toBe('NEWER');
    expect(clientCompatibility(server, v('2.0'))).toBe('NEWER');
    expect(isClientServed(server, v('1.5'))).toBe(true);
  });

  it('serves an app that does not say which API it speaks', () => {
    expect(clientCompatibility(server, undefined)).toBe('UNKNOWN');
    expect(isClientServed(server, undefined)).toBe(true);
  });

  it('an update to 1.5 leaves 1.3 apps behind, which the 1.4 server still serves', () => {
    expect(clientCompatibility(v('1.4'), v('1.3'))).toBe('PREVIOUS');
    expect(clientCompatibility(v('1.5'), v('1.3'))).toBe('TOO_OLD');
  });
});

describe('[UPD-006] the identity an app sends', () => {
  it('reads kind, app version and API', () => {
    expect(parseClientIdentity('waiter-app/1.4.2 api/1.3')).toEqual({
      kind: 'waiter-app',
      version: '1.4.2',
      api: { major: 1, minor: 3 },
    });
    expect(parseClientIdentity('console/0.1.0-beta.2+build.7 api/1.0')?.version).toBe(
      '0.1.0-beta.2+build.7',
    );
    expect(parseClientIdentity('  table-tablet/2.0.0 api/1.0 ')?.kind).toBe('table-tablet');
  });

  it('writes what it reads', () => {
    const identity = { kind: 'console', version: '1.0.0', api: v('1.2') };
    expect(formatClientIdentity(identity)).toBe('console/1.0.0 api/1.2');
    expect(parseClientIdentity(formatClientIdentity(identity))).toEqual(identity);
  });

  it('ignores anything malformed, so the request is served as UNKNOWN', () => {
    for (const bad of [
      undefined,
      '',
      'waiter-app/1.4.2',
      'waiter-app api/1.3',
      'Waiter/1.4.2 api/1.3',
      'waiter-app/1.4.2 api/1.3.0',
      'waiter-app/1.4.2 api/v1',
      'waiter-app/1.4.2  api/1.3',
      `${'a'.repeat(41)}/1.0.0 api/1.0`,
      `waiter-app/${'1'.repeat(41)} api/1.0`,
      'waiter-app/../../x api/1.0',
    ]) {
      expect(parseClientIdentity(bad), String(bad)).toBeUndefined();
    }
  });
});

describe('[UPD-006] the component version matrix', () => {
  const history = [
    { api: '1.0', since: '1.0.0' },
    { api: '1.1', since: '1.2.0' },
    { api: '1.2', since: '1.5.0' },
  ];

  it('finds the first release whose apps speak an API or newer', () => {
    expect(firstReleaseSpeaking(history, v('1.0'))).toBe('1.0.0');
    expect(firstReleaseSpeaking(history, v('1.1'))).toBe('1.2.0');
    expect(firstReleaseSpeaking(history, v('1.2'))).toBe('1.5.0');
    expect(firstReleaseSpeaking(history, v('1.3'))).toBeUndefined();
    expect(firstReleaseSpeaking([{ api: 'x', since: '1.0.0' }], v('1.0'))).toBeUndefined();
  });

  it('lists the release, its client API range and the oldest app builds it serves', () => {
    const matrix = buildVersionMatrix({
      release: '1.6.0',
      clientApi: '1.2',
      history,
      components: [
        { name: 'server', version: '1.6.0' },
        { name: 'node', version: '24.21.0' },
      ],
      clients: [
        { kind: 'waiter-app', version: '1.6.0' },
        { kind: 'table-tablet', version: '1.6.0' },
      ],
      pagerProtocol: 1,
    });
    expect(matrix).toEqual({
      release: '1.6.0',
      clientApi: { current: '1.2', oldest: '1.1' },
      components: [
        { name: 'server', version: '1.6.0' },
        { name: 'node', version: '24.21.0' },
      ],
      clients: [
        { kind: 'waiter-app', version: '1.6.0', minimumVersion: '1.2.0' },
        { kind: 'table-tablet', version: '1.6.0', minimumVersion: '1.2.0' },
      ],
      pagerProtocol: 1,
    });
  });

  it('has no minimum before any release speaks the oldest API', () => {
    const matrix = buildVersionMatrix({
      release: '0.1.0',
      clientApi: '1.0',
      history: [],
      components: [],
      clients: [{ kind: 'console', version: '0.1.0' }],
      pagerProtocol: 1,
    });
    expect(matrix.clientApi).toEqual({ current: '1.0', oldest: '1.0' });
    expect(matrix.clients[0]?.minimumVersion).toBeNull();
  });

  it('refuses a malformed release or API version', () => {
    const base = { history, components: [], clients: [], pagerProtocol: 1 };
    expect(() => buildVersionMatrix({ ...base, release: '1.6', clientApi: '1.2' })).toThrow(
      RangeError,
    );
    expect(() => buildVersionMatrix({ ...base, release: '1.6.0', clientApi: '1' })).toThrow(
      RangeError,
    );
  });
});
