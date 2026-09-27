import {
  InvalidServerAddressError,
  ServerMismatchError,
  ServerUnreachableError,
  UnverifiedServerError,
} from '@rp/mobile-core';
import { FakeTrust, LAN_CA, OTHER_CA } from '@rp/mobile-core/testing';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { formatFingerprint, messageOf, PairingScreen } from '../src/index.js';
import { fakeServer, newSession, renderShell, translator } from './harness.js';

const LAN = 'https://192.168.1.20:8443';
const ELSEWHERE = 'https://10.0.0.5:8443';

const mockCamera: {
  permission: { granted: boolean; canAskAgain: boolean } | null;
  requests: number;
} = { permission: null, requests: 0 };

// The camera: a view the test "shows" a QR code to by firing `barcodeScanned` at it.
jest.mock('expo-camera', () => {
  const { createElement } = jest.requireActual<{
    createElement: (type: unknown, props: object) => unknown;
  }>('react');
  const { View } = jest.requireActual<{ View: unknown }>('react-native');
  return {
    CameraView: (props: object) => createElement(View, props),
    useCameraPermissions: () => [
      mockCamera.permission,
      () => {
        mockCamera.requests += 1;
        return Promise.resolve(mockCamera.permission);
      },
    ],
  };
});

beforeEach(() => {
  mockCamera.permission = { granted: true, canAskAgain: true };
  mockCamera.requests = 0;
});

function qr(payload: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, code: 'ABCD-EFGH', ...payload });
}

async function setup(trust: FakeTrust) {
  const server = fakeServer();
  const { session } = newSession(server, trust);
  await session.start();
  await renderShell(session, <PairingScreen />);
  return { server, session };
}

async function scan(data: string) {
  await fireEvent.press(screen.getByTestId('pairing-scan'));
  await fireEvent(await screen.findByTestId('pairing-camera'), 'barcodeScanned', { data });
}

describe('[AUTH-007] [SEC-010] pairing with the QR code (ADR-0011)', () => {
  it('finds the server among the addresses in the QR code and pins its certificate', async () => {
    const trust = new FakeTrust().serve(LAN, LAN_CA);
    const { server, session } = await setup(trust);

    await scan(qr({ ca: LAN_CA.sha256, urls: [ELSEWHERE, LAN] }));

    await waitFor(() => {
      expect(session.getSnapshot().phase).toBe('paired');
    });
    expect(session.getSnapshot().serverUrl).toBe(LAN);
    expect(trust.pinned).toEqual({ certificate: LAN_CA.certificate, serverUrl: LAN });
    expect(server.callsTo('POST', '/api/v1/devices/pair')[0]?.body).toMatchObject({
      code: 'ABCD-EFGH',
    });
  });

  it('refuses a server whose certificate is not the one in the QR code', async () => {
    const trust = new FakeTrust().serve(LAN, OTHER_CA);
    const { server, session } = await setup(trust);
    await scan(qr({ ca: LAN_CA.sha256, urls: [LAN] }));
    expect(await screen.findByTestId('pairing-error')).toHaveTextContent(
      translator('pairing.mismatch'),
    );
    expect(session.getSnapshot().phase).toBe('unpaired');
    expect(trust.pinned).toBeUndefined();
    expect(server.calls).toHaveLength(0);
  });

  it('says so when no address in the QR code answers', async () => {
    const { session } = await setup(new FakeTrust());
    await scan(qr({ ca: LAN_CA.sha256, urls: [LAN, ELSEWHERE] }));
    expect(await screen.findByTestId('pairing-error')).toHaveTextContent(
      translator('pairing.unreachable'),
    );
    expect(session.getSnapshot().phase).toBe('unpaired');
    // The address stays filled in, to correct and try again.
    expect(screen.getByLabelText('Server address')).toHaveDisplayValue(LAN);
    expect(screen.getByLabelText('Pairing code')).toHaveDisplayValue('ABCD-EFGH');
  });

  it('fills in the code from a QR code without addresses and checks the typed address against it', async () => {
    const trust = new FakeTrust().serve(LAN, LAN_CA);
    const { session } = await setup(trust);
    await scan(qr({ ca: LAN_CA.sha256 }));
    expect(screen.getByTestId('pairing-hint')).toHaveTextContent(translator('pairing.enterServer'));
    expect(screen.getByLabelText('Pairing code')).toHaveDisplayValue('ABCD-EFGH');

    await fireEvent.changeText(screen.getByLabelText('Server address'), '192.168.1.20:8443');
    await fireEvent.press(screen.getByTestId('pairing-submit'));

    await waitFor(() => {
      expect(session.getSnapshot().phase).toBe('paired');
    });
    expect(screen.queryByTestId('pairing-fingerprint')).toBeNull();
    expect(trust.pinned?.serverUrl).toBe(LAN);
  });

  it('says so when the QR code is not a pairing code, and lets the person type instead', async () => {
    await setup(new FakeTrust());
    await scan('https://example.com/menu');
    expect(screen.getByTestId('pairing-error')).toHaveTextContent(
      translator('pairing.notPairingCode'),
    );

    await fireEvent.press(screen.getByTestId('pairing-scan'));
    await fireEvent.press(await screen.findByTestId('pairing-type-instead'));
    expect(screen.getByTestId('pairing-submit')).toBeOnTheScreen();
  });
});

describe('[AUTH-007] [SEC-010] pairing with a typed address over TLS', () => {
  it('shows the server’s certificate fingerprint for a person to compare before pairing', async () => {
    const trust = new FakeTrust().serve(LAN, LAN_CA);
    const { server, session } = await setup(trust);
    await fireEvent.changeText(screen.getByLabelText('Server address'), '192.168.1.20:8443');
    await fireEvent.changeText(screen.getByLabelText('Pairing code'), 'ABCDEFGH');
    await fireEvent.press(screen.getByTestId('pairing-submit'));

    expect(await screen.findByTestId('pairing-fingerprint')).toHaveTextContent(
      formatFingerprint(LAN_CA.sha256),
    );
    await fireEvent.press(screen.getByTestId('pairing-check-cancel'));
    expect(screen.getByTestId('pairing-submit')).toBeOnTheScreen();
    expect(server.calls).toHaveLength(0);
    expect(trust.pinned).toBeUndefined();

    await fireEvent.press(screen.getByTestId('pairing-submit'));
    await fireEvent.press(await screen.findByTestId('pairing-confirm'));
    await waitFor(() => {
      expect(session.getSnapshot().phase).toBe('paired');
    });
    expect(trust.pinned).toEqual({ certificate: LAN_CA.certificate, serverUrl: LAN });
  });
});

describe('[AUTH-007] the camera', () => {
  it('waits for the camera and explains when it is not allowed', async () => {
    mockCamera.permission = null;
    await setup(new FakeTrust());
    await fireEvent.press(screen.getByTestId('pairing-scan'));
    expect(await screen.findByText(translator('pairing.scanHint'))).toBeOnTheScreen();
    expect(screen.getByText(translator('pairing.cameraStarting'))).toBeOnTheScreen();
    expect(screen.queryByTestId('pairing-camera')).toBeNull();
  });

  it('asks again for the camera when it may', async () => {
    mockCamera.permission = { granted: false, canAskAgain: true };
    await setup(new FakeTrust());
    await fireEvent.press(screen.getByTestId('pairing-scan'));
    expect(await screen.findByTestId('pairing-camera-denied')).toHaveTextContent(
      translator('pairing.cameraDenied'),
    );
    await fireEvent.press(screen.getByRole('button', { name: translator('pairing.allowCamera') }));
    expect(mockCamera.requests).toBe(1);
  });

  it('switches between the back and front cameras', async () => {
    await setup(new FakeTrust());
    await fireEvent.press(screen.getByTestId('pairing-scan'));
    expect(await screen.findByTestId('pairing-camera')).toHaveProp('facing', 'back');
    await fireEvent.press(screen.getByRole('button', { name: translator('pairing.switchCamera') }));
    expect(screen.getByTestId('pairing-camera')).toHaveProp('facing', 'front');
  });
});

describe('pairing messages', () => {
  it('says what to do when the server cannot be found or trusted', () => {
    expect(messageOf(new ServerUnreachableError([LAN]), translator)).toBe(
      translator('pairing.unreachable'),
    );
    expect(messageOf(new ServerMismatchError(), translator)).toBe(translator('pairing.mismatch'));
    expect(messageOf(new UnverifiedServerError(), translator)).toBe(
      translator('pairing.unverified'),
    );
    expect(messageOf(new InvalidServerAddressError(), translator)).toBe(
      translator('mobile.invalidServer'),
    );
  });

  it('shows a fingerprint as four lines of eight pairs', () => {
    expect(formatFingerprint(LAN_CA.sha256).split('\n')).toEqual([
      '3A:3B:3C:3D:3E:3F:40:41',
      '42:43:44:45:46:47:48:49',
      '4A:4B:4C:4D:4E:4F:50:51',
      '52:53:54:55:56:57:58:59',
    ]);
  });
});
