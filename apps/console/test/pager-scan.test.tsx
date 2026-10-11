import { screen, waitFor, within } from '@testing-library/react';
import { encode } from 'uqr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeServer } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { credential, crewList, PAGER_2, pager, pagerList } from './sections-fixture.js';

/** Registering a pager by reading its QR code with the camera (P2-04b2). */

const PATH = '/manage/staff/pagers';
const PAGERS = '/api/v1/pagers';

function pagersServer(): FakeServer {
  return signsInAs(server(), 'MANAGER')
    .on('GET', '/api/v1/staff', () => ({ status: 200, body: crewList() }))
    .on(
      'GET',
      PAGERS,
      () => ({ status: 200, body: pagerList() }),
      () => ({
        status: 200,
        body: pagerList([
          pager(),
          pager({ deviceId: PAGER_2, name: 'Pager 2', serial: 'WP-0002' }),
        ]),
      }),
    )
    .on('POST', PAGERS, () => ({ status: 201, body: credential() }));
}

/** An RGBA camera frame showing the QR code for `text`, as jsQR receives it from the canvas. */
function frameOf(text: string): { data: Uint8ClampedArray; width: number; height: number } {
  const code = encode(text, { ecc: 'M', border: 4 });
  const scale = 4;
  const width = code.size * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  code.data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const at = ((y * scale + dy) * width + x * scale + dx) * 4;
          data.set([0, 0, 0, 255], at);
        }
      }
    });
  });
  return { data, width, height: width };
}

/**
 * The browser's camera, stubbed where the console meets it: `getUserMedia`, the video playing
 * and the canvas the frames are drawn on. Each frame read shows the next code in `codes`; without
 * codes the camera sees none.
 */
function cameraShowing(...codes: string[]) {
  const blank = { data: new Uint8ClampedArray(64 * 48 * 4).fill(255), width: 64, height: 48 };
  const frames = codes.length === 0 ? [blank] : codes.map(frameOf);
  const track = { stop: vi.fn(), getSettings: () => ({ facingMode: 'environment' }) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const getUserMedia = vi.fn(() => Promise.resolve(stream));
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(640);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(480);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    getImageData: () => (frames.length > 1 ? frames.shift() : frames[0]),
  } as unknown as CanvasRenderingContext2D);
  return { getUserMedia, track };
}

async function openRegister() {
  const rendered = await renderConsole({ fake: pagersServer(), path: PATH, signedIn: 'MANAGER' });
  await rendered.user.click(await screen.findByRole('button', { name: t('pagers.register') }));
  const dialog = await screen.findByRole('dialog', { name: t('pagers.form.title') });
  return { ...rendered, dialog, form: within(dialog) };
}

const serialIn = (dialog: HTMLElement) =>
  within(dialog).getByLabelText(new RegExp(`^${t('pagers.form.serial')}`));

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'mediaDevices');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('[PGR-012] registering a pager by its QR code (P2-04b2)', () => {
  it("reads the serial with the camera, passing over a code that is not a pager's", async () => {
    const camera = cameraShowing('{"v":1,"code":"K7Q2-M9XD"}', 'RP-PAGER:WP-0002');
    const { user, dialog, form, fake } = await openRegister();

    await user.click(form.getByRole('button', { name: t('pagers.scan.start') }));
    expect(form.getByRole('img', { name: t('pagers.scan.camera') })).toBeVisible();
    expect(camera.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false }));
    // A device pairing code is read first: the camera keeps looking.
    expect(await form.findByText(t('pagers.scan.notPager'))).toBeVisible();

    const read = await form.findByText(t('pagers.scan.read', { serial: 'WP-0002' }));
    expect(read).toHaveAttribute('role', 'status');
    expect(form.queryByRole('img', { name: t('pagers.scan.camera') })).toBeNull();
    // The scanner turns the camera off in its effect's clean-up, which React runs after the read
    // is on screen (the read came from the scanner's timer, not from an event).
    await waitFor(() => {
      expect(camera.track.stop).toHaveBeenCalled();
    });
    const serial = serialIn(dialog);
    expect(serial).toHaveValue('WP-0002');
    expect(serial).toHaveFocus();
    await expectNoAxeViolations(dialog);

    await user.click(form.getByRole('button', { name: t('pagers.form.register') }));
    await screen.findByRole('dialog', {
      name: t('pagers.credentialDialog.title', { pager: 'Pager 2' }),
    });
    expect(fake.callsTo('POST', PAGERS)[0]?.body).toEqual({
      serial: 'WP-0002',
      name: 'Pager 2',
      staffId: null,
    });
  });

  it('stops scanning on request, and turns the camera off when the dialog closes', async () => {
    const camera = cameraShowing();
    const { user, form } = await openRegister();

    await user.click(form.getByRole('button', { name: t('pagers.scan.start') }));
    expect(await form.findByText(t('pagers.scan.hold'))).toBeVisible();
    await user.click(form.getByRole('button', { name: t('pagers.scan.stop') }));
    expect(form.queryByRole('img', { name: t('pagers.scan.camera') })).toBeNull();
    await waitFor(() => {
      expect(camera.track.stop).toHaveBeenCalledTimes(1);
    });

    await user.click(form.getByRole('button', { name: t('pagers.scan.start') }));
    await waitFor(() => {
      expect(camera.getUserMedia).toHaveBeenCalledTimes(2);
    });
    await user.click(form.getByRole('button', { name: t('pagers.form.cancel') }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: t('pagers.form.title') })).toBeNull();
    });
    await waitFor(() => {
      expect(camera.track.stop).toHaveBeenCalledTimes(2);
    });
  });

  it('says why the camera cannot scan, and the serial can still be typed', async () => {
    const camera = cameraShowing('RP-PAGER:WP-0002');
    const refused = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    camera.getUserMedia.mockRejectedValueOnce(refused);
    const { user, dialog, form } = await openRegister();

    await user.click(form.getByRole('button', { name: t('pagers.scan.start') }));
    expect(await form.findByRole('alert')).toHaveTextContent(t('pagers.scan.denied'));
    expect(form.getByRole('button', { name: t('pagers.scan.again') })).toBeVisible();
    await user.type(serialIn(dialog), 'WP-0002');
    expect(serialIn(dialog)).toHaveValue('WP-0002');
  });

  it('keeps only the serial when a barcode scanner types the whole code', async () => {
    const { user, dialog } = await openRegister();
    await user.type(serialIn(dialog), 'RP-PAGER:WP-0002');
    expect(serialIn(dialog)).toHaveValue('WP-0002');
  });

  it('offers no camera where the browser has none (a page that is not HTTPS)', async () => {
    const { dialog, form } = await openRegister();
    expect(form.queryByRole('button', { name: t('pagers.scan.start') })).toBeNull();
    expect(serialIn(dialog)).toHaveFocus();
  });
});
