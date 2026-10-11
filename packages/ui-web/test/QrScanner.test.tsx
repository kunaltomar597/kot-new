import { screen, waitFor } from '@testing-library/react';
import { encode } from 'uqr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserQrCamera,
  CameraError,
  cameraProblemOf,
  decodeQr,
  frameSize,
  hasCameraApi,
  type QrCamera,
  type QrCameraSession,
  QrScanner,
} from '../src/index.js';
import { expectNoAxeViolations, renderUi } from './render.js';

/** An RGBA picture of the QR code for `text`, `scale` pixels per module, as a camera would see. */
function pictureOf(
  text: string,
  { scale = 4, inverted = false }: { scale?: number; inverted?: boolean } = {},
): { data: Uint8ClampedArray; width: number; height: number } {
  const code = encode(text, { ecc: 'M', border: 4 });
  const width = code.size * scale;
  const data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dark = code.data[Math.floor(y / scale)]![Math.floor(x / scale)]!;
      const value = dark !== inverted ? 0 : 255;
      data.set([value, value, value, 255], (y * width + x) * 4);
    }
  }
  return { data, width, height: width };
}

describe('[PGR-012] reading a QR code from a camera frame', () => {
  it('reads the text of a code, dark on light', () => {
    expect(decodeQr(pictureOf('RP-PAGER:3C84279A1B2C'))).toBe('RP-PAGER:3C84279A1B2C');
  });

  it("reads a code shown light on dark, as on a pager's screen", () => {
    expect(decodeQr(pictureOf('RP-PAGER:PGR-0042', { inverted: true }))).toBe('RP-PAGER:PGR-0042');
  });

  it('finds nothing in a frame without a code', () => {
    const blank = new Uint8ClampedArray(64 * 48 * 4).fill(255);
    expect(decodeQr({ data: blank, width: 64, height: 48 })).toBeUndefined();
  });

  it('scales large frames down to 640 pixels on the long side', () => {
    expect(frameSize(1280, 720)).toEqual({ width: 640, height: 360 });
    expect(frameSize(720, 1280)).toEqual({ width: 360, height: 640 });
    expect(frameSize(320, 240)).toEqual({ width: 320, height: 240 });
    expect(frameSize(4000, 2)).toEqual({ width: 640, height: 1 });
  });

  it('says why the camera failed, by the browser error', () => {
    const named = (name: string) => Object.assign(new Error(name), { name });
    expect(cameraProblemOf(named('NotAllowedError'))).toBe('DENIED');
    expect(cameraProblemOf(named('SecurityError'))).toBe('DENIED');
    expect(cameraProblemOf(named('NotFoundError'))).toBe('NO_CAMERA');
    expect(cameraProblemOf(named('OverconstrainedError'))).toBe('NO_CAMERA');
    expect(cameraProblemOf(named('NotReadableError'))).toBe('BUSY');
    expect(cameraProblemOf(named('AbortError'))).toBe('BUSY');
    expect(cameraProblemOf(named('TypeError'))).toBe('FAILED');
    expect(cameraProblemOf('no error at all')).toBe('FAILED');
    expect(cameraProblemOf(new CameraError('UNSUPPORTED'))).toBe('UNSUPPORTED');
  });
});

describe("[PGR-012] the browser's camera", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function fakeStream(facingMode?: string) {
    const track = { stop: vi.fn(), getSettings: () => (facingMode ? { facingMode } : {}) };
    return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } };
  }

  function stubCamera(stream: unknown) {
    const getUserMedia = vi.fn(() => Promise.resolve(stream));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    return getUserMedia;
  }

  /** A video element that has a 1280 × 720 frame to draw. */
  function playingVideo(): HTMLVideoElement {
    const video = document.createElement('video');
    Object.defineProperty(video, 'readyState', { value: 4 });
    Object.defineProperty(video, 'videoWidth', { value: 1280 });
    Object.defineProperty(video, 'videoHeight', { value: 720 });
    return video;
  }

  it('is not offered without the camera API (a page that is not HTTPS)', async () => {
    vi.stubGlobal('navigator', { mediaDevices: undefined });
    expect(hasCameraApi()).toBe(false);
    await expect(browserQrCamera.open(document.createElement('video'))).rejects.toEqual(
      new CameraError('UNSUPPORTED'),
    );
  });

  it('opens the back camera without sound and reads the code in the current frame', async () => {
    const { stream, track } = fakeStream('environment');
    const getUserMedia = stubCamera(stream);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const drawImage = vi.fn();
    const picture = pictureOf('RP-PAGER:PGR-0042');
    const getImageData = vi.fn(() => picture);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
      getImageData,
    } as unknown as CanvasRenderingContext2D);
    expect(hasCameraApi()).toBe(true);

    const video = playingVideo();
    const session = await browserQrCamera.open(video);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
    });
    expect(video.srcObject).toBe(stream);
    expect(session.facesUser).toBe(false);
    expect(session.read()).toBe('RP-PAGER:PGR-0042');
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 640, 360);
    expect(getImageData).toHaveBeenCalledWith(0, 0, 640, 360);

    session.stop();
    expect(track.stop).toHaveBeenCalled();
    expect(video.srcObject).toBeNull();

    // Opened again on the same video, a late stop of the first camera leaves the second's picture.
    const second = fakeStream('environment');
    getUserMedia.mockResolvedValueOnce(stream).mockResolvedValueOnce(second.stream);
    const first = await browserQrCamera.open(video);
    const again = await browserQrCamera.open(video);
    first.stop();
    expect(video.srcObject).toBe(second.stream);
    again.stop();
    expect(video.srcObject).toBeNull();
  });

  it('reads nothing before the video has a frame, and mirrors a webcam', async () => {
    stubCamera(fakeStream().stream);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    const session = await browserQrCamera.open(document.createElement('video'));
    expect(session.facesUser).toBe(true);
    expect(session.read()).toBeUndefined();
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('turns the camera off again when the video cannot play', async () => {
    const { stream, track } = fakeStream('environment');
    stubCamera(stream);
    const refused = Object.assign(new Error('refused'), { name: 'NotAllowedError' });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(refused);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      {} as unknown as CanvasRenderingContext2D,
    );
    await expect(browserQrCamera.open(document.createElement('video'))).rejects.toBe(refused);
    expect(track.stop).toHaveBeenCalled();
  });

  it('turns the camera off again when frames cannot be drawn', async () => {
    const { stream, track } = fakeStream('environment');
    stubCamera(stream);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await expect(browserQrCamera.open(document.createElement('video'))).rejects.toEqual(
      new CameraError('FAILED'),
    );
    expect(track.stop).toHaveBeenCalled();
  });
});

/** A camera whose frames hold the texts given, one per read (undefined: no code in view). */
function fakeCamera(frames: (string | undefined)[], { facesUser = false } = {}) {
  const stop = vi.fn();
  let opened: (session: QrCameraSession) => void = () => undefined;
  let failed: (error: unknown) => void = () => undefined;
  const session: QrCameraSession = {
    read: () => (frames.length > 1 ? frames.shift() : frames[0]),
    facesUser,
    stop,
  };
  const openCamera = vi.fn(
    () =>
      new Promise<QrCameraSession>((resolve, reject) => {
        opened = resolve;
        failed = reject;
      }),
  );
  const camera: QrCamera = { open: openCamera };
  return {
    camera,
    openCamera,
    stop,
    open: () => {
      opened(session);
    },
    fail: (error: unknown) => {
      failed(error);
    },
  };
}

describe('[PGR-012] QrScanner', () => {
  it('shows the camera and reports each code read once', async () => {
    const fake = fakeCamera([undefined, 'RP-TABLE:T1', 'RP-TABLE:T1', undefined, 'RP-PAGER:PGR1']);
    const onRead = vi.fn();
    const { container } = renderUi(
      <QrScanner
        label="Camera for the pager's code"
        interval={1}
        camera={fake.camera}
        onRead={onRead}
        onProblem={vi.fn()}
      />,
    );
    const view = screen.getByRole('img', { name: "Camera for the pager's code" });
    expect(view).toHaveAttribute('aria-busy', 'true');
    expect(fake.openCamera).toHaveBeenCalledWith(container.querySelector('video'));
    fake.open();
    await waitFor(() => {
      expect(onRead).toHaveBeenCalledTimes(2);
    });
    expect(onRead.mock.calls).toEqual([['RP-TABLE:T1'], ['RP-PAGER:PGR1']]);
    expect(view).toHaveAttribute('data-state', 'scanning');
    expect(view).not.toHaveAttribute('aria-busy');
    expect(container.querySelector('video')).not.toHaveClass('rp-qr-scanner__video--mirrored');
    await expectNoAxeViolations(container);
  });

  it('mirrors a camera that faces the person', async () => {
    const fake = fakeCamera([undefined], { facesUser: true });
    const { container } = renderUi(
      <QrScanner label="Camera" camera={fake.camera} onRead={vi.fn()} onProblem={vi.fn()} />,
    );
    fake.open();
    await waitFor(() => {
      expect(container.querySelector('video')).toHaveClass('rp-qr-scanner__video--mirrored');
    });
  });

  it('turns the camera off when it is closed', async () => {
    const fake = fakeCamera([undefined]);
    const { unmount } = renderUi(
      <QrScanner
        label="Camera"
        interval={1}
        camera={fake.camera}
        onRead={vi.fn()}
        onProblem={vi.fn()}
      />,
    );
    fake.open();
    await waitFor(() => {
      expect(screen.getByRole('img')).toHaveAttribute('data-state', 'scanning');
    });
    unmount();
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it('turns a camera off that opens after the scanner was closed', async () => {
    const fake = fakeCamera(['RP-PAGER:PGR1']);
    const onRead = vi.fn();
    const { unmount } = renderUi(
      <QrScanner label="Camera" camera={fake.camera} onRead={onRead} onProblem={vi.fn()} />,
    );
    unmount();
    fake.open();
    await waitFor(() => {
      expect(fake.stop).toHaveBeenCalledTimes(1);
    });
    expect(onRead).not.toHaveBeenCalled();
  });

  it('says once why the camera cannot be used', async () => {
    const fake = fakeCamera([]);
    const onProblem = vi.fn();
    renderUi(
      <QrScanner label="Camera" camera={fake.camera} onRead={vi.fn()} onProblem={onProblem} />,
    );
    fake.fail(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await waitFor(() => {
      expect(onProblem).toHaveBeenCalledWith('DENIED');
    });
    expect(onProblem).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('img')).toHaveAttribute('data-state', 'stopped');
  });

  it('turns the camera off and says so when a frame cannot be read', async () => {
    const stop = vi.fn();
    const camera: QrCamera = {
      open: () =>
        Promise.resolve({
          facesUser: false,
          read: () => {
            throw new Error('The canvas is gone');
          },
          stop,
        }),
    };
    const onProblem = vi.fn();
    const { unmount } = renderUi(
      <QrScanner label="Camera" camera={camera} onRead={vi.fn()} onProblem={onProblem} />,
    );
    await waitFor(() => {
      expect(onProblem).toHaveBeenCalledWith('FAILED');
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('img')).toHaveAttribute('data-state', 'stopped');
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('does not report a problem after it was closed', async () => {
    const fake = fakeCamera([]);
    const onProblem = vi.fn();
    const { unmount } = renderUi(
      <QrScanner label="Camera" camera={fake.camera} onRead={vi.fn()} onProblem={onProblem} />,
    );
    unmount();
    fake.fail(new Error('late'));
    await Promise.resolve();
    expect(onProblem).not.toHaveBeenCalled();
  });
});
