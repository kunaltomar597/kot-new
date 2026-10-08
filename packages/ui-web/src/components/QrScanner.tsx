import jsQRModule from 'jsqr';
import { useEffect, useRef, useState } from 'react';
import { cx } from '../internal/cx.js';

// jsQR is CommonJS with `exports.default`: Node's loader hands over `module.exports` and a bundler
// the function itself, and both have `.default` (jsQR sets `jsQR.default = jsQR`).
const jsQR = jsQRModule.default;

/** Why the camera cannot scan, for the screen to say what to do instead (ADR-0019). */
export type CameraProblem =
  /** No camera API: an old browser, or a page not opened over HTTPS (or on this PC). */
  | 'UNSUPPORTED'
  /** The person, the browser's settings or the page's permissions policy refused the camera. */
  | 'DENIED'
  /** No camera on this device, or none that fits. */
  | 'NO_CAMERA'
  /** The camera is there but another app holds it. */
  | 'BUSY'
  | 'FAILED';

/** An open camera that reads QR codes, one frame at a time. */
export interface QrCameraSession {
  /** The text of the QR code in the current frame, or undefined when none is readable. */
  read(): string | undefined;
  /** Whether the camera faces the person (a PC's webcam): the preview is mirrored, like a mirror. */
  readonly facesUser: boolean;
  /** Turns the camera off. */
  stop(): void;
}

/** Opens a camera into a video element. The browser's own is `browserQrCamera`; tests pass a fake. */
export interface QrCamera {
  open(video: HTMLVideoElement): Promise<QrCameraSession>;
}

/** An error that already says which `CameraProblem` it is. */
export class CameraError extends Error {
  constructor(readonly problem: CameraProblem) {
    super(`Camera: ${problem}`);
    this.name = 'CameraError';
  }
}

/** The problem behind a failed `getUserMedia` or `play`, by the DOMException's name. */
export function cameraProblemOf(error: unknown): CameraProblem {
  if (error instanceof CameraError) return error.problem;
  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return 'DENIED';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'NO_CAMERA';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'BUSY';
    default:
      return 'FAILED';
  }
}

/** Whether this browser offers a camera at all (it does only on HTTPS pages or on this PC). */
export function hasCameraApi(): boolean {
  if (typeof navigator === 'undefined') return false;
  // Browsers leave `mediaDevices` out on a page that is not a secure context.
  const devices = (navigator as { mediaDevices?: Partial<MediaDevices> }).mediaDevices;
  return typeof devices?.getUserMedia === 'function';
}

/** The longest side of the frame that is decoded: a QR code held close reads well at this size. */
export const QR_FRAME_SIZE = 640;

/** The frame size to decode: the camera's, scaled down to `limit` on its longest side. */
export function frameSize(
  width: number,
  height: number,
  limit = QR_FRAME_SIZE,
): { width: number; height: number } {
  const scale = Math.min(1, limit / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * The text of a QR code in an RGBA image, or undefined. Dark-on-light and light-on-dark codes are
 * both read: a pager's screen may show its code light on dark.
 */
export function decodeQr(image: {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}): string | undefined {
  const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
  return code === null || code.data === '' ? undefined : code.data;
}

/** `HTMLMediaElement.HAVE_CURRENT_DATA`: the video has a frame to draw. */
const HAVE_CURRENT_DATA = 2;

/**
 * The browser's camera: the back camera on a phone, the webcam on a PC, video only. Each `read`
 * draws the current frame onto a canvas at `frameSize` and decodes it with jsQR, so codes are read
 * in every browser, Windows Chromium included (which has no `BarcodeDetector`), and offline.
 */
export const browserQrCamera: QrCamera = {
  async open(video) {
    if (!hasCameraApi()) throw new CameraError('UNSUPPORTED');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
    });
    const stop = () => {
      for (const track of stream.getTracks()) track.stop();
      // A camera opened again on the same video since then keeps its picture.
      if (video.srcObject === stream) video.srcObject = null;
    };
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    try {
      if (context === null) throw new CameraError('FAILED');
      video.srcObject = stream;
      await video.play();
    } catch (error) {
      stop();
      throw error;
    }
    const facing = stream.getVideoTracks()[0]?.getSettings().facingMode;
    return {
      facesUser: facing !== 'environment',
      read() {
        if (video.readyState < HAVE_CURRENT_DATA || video.videoWidth === 0) return undefined;
        const { width, height } = frameSize(video.videoWidth, video.videoHeight);
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        context.drawImage(video, 0, 0, width, height);
        return decodeQr(context.getImageData(0, 0, width, height));
      },
      stop,
    };
  },
};

export interface QrScannerProps {
  /**
   * Called with the text of each QR code read. The same text is not repeated until another code
   * has been read, so a screen can say "that is not a pager's code" once. Unmount the scanner to
   * turn the camera off.
   */
  onRead: (text: string) => void;
  /** Called once when the camera cannot be used; the screen says why and offers to type instead. */
  onProblem: (problem: CameraProblem) => void;
  /** What the camera view is for, read by screen readers ("Camera for the pager's QR code"). */
  label: string;
  /** Milliseconds between frames read. */
  interval?: number;
  camera?: QrCamera;
  className?: string;
}

/**
 * A live camera view that reads QR codes (PGR-012: a pager's code on the Pagers page, ADR-0019).
 * The camera opens when the scanner mounts and turns off when it unmounts; nothing leaves the
 * device. A square in the middle shows where to hold the code.
 */
export function QrScanner({
  onRead,
  onProblem,
  label,
  interval = 150,
  camera = browserQrCamera,
  className,
}: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'starting' | 'scanning' | 'stopped'>('starting');
  const [mirrored, setMirrored] = useState(false);
  // The latest callbacks, so a parent's new functions do not reopen the camera.
  const handlers = useRef({ onRead, onProblem });
  useEffect(() => {
    handlers.current = { onRead, onProblem };
  });

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return undefined;
    let ended = false;
    let session: QrCameraSession | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: string | undefined;

    const tick = () => {
      if (ended || session === undefined) return;
      let text: string | undefined;
      try {
        text = session.read();
      } catch (error) {
        session.stop();
        session = undefined;
        setState('stopped');
        handlers.current.onProblem(cameraProblemOf(error));
        return;
      }
      if (text !== undefined && text !== last) {
        last = text;
        handlers.current.onRead(text);
      }
      timer = setTimeout(tick, interval);
    };

    camera.open(video).then(
      (opened) => {
        if (ended) {
          opened.stop();
          return;
        }
        session = opened;
        setMirrored(opened.facesUser);
        setState('scanning');
        tick();
      },
      (error: unknown) => {
        if (ended) return;
        setState('stopped');
        handlers.current.onProblem(cameraProblemOf(error));
      },
    );

    return () => {
      ended = true;
      if (timer !== undefined) clearTimeout(timer);
      session?.stop();
    };
  }, [camera, interval]);

  return (
    <div
      role="img"
      aria-label={label}
      aria-busy={state === 'starting' || undefined}
      data-state={state}
      className={cx('rp-qr-scanner', className)}
    >
      <video
        ref={videoRef}
        className={cx('rp-qr-scanner__video', mirrored && 'rp-qr-scanner__video--mirrored')}
        muted
        playsInline
        disablePictureInPicture
      />
      <span className="rp-qr-scanner__target" />
    </div>
  );
}
