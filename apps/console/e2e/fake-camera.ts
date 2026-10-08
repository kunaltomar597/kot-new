import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode } from 'uqr';

const WIDTH = 320;
const HEIGHT = 240;
/** Pixels per QR module: a version 1 code (29 modules with its quiet zone) is 174 px wide. */
const SCALE = 6;

/**
 * Writes a one-frame Y4M video of the QR code for `text` on a white background and returns its
 * path, for Chromium's `--use-file-for-fake-video-capture`: the browser's camera then shows the
 * code, so the e2e test scans it through `getUserMedia`, the video and jsQR (P2-04b2).
 */
export function fakeCameraShowing(text: string): string {
  const code = encode(text, { ecc: 'M', border: 4 });
  const size = code.size * SCALE;
  const left = Math.floor((WIDTH - size) / 2);
  const top = Math.floor((HEIGHT - size) / 2);
  const luma = Buffer.alloc(WIDTH * HEIGHT, 255);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (code.data[Math.floor(y / SCALE)]?.[Math.floor(x / SCALE)] === true) {
        luma[(top + y) * WIDTH + left + x] = 0;
      }
    }
  }
  // 4:2:0 chroma at the neutral value: a black and white picture.
  const chroma = Buffer.alloc((WIDTH / 2) * (HEIGHT / 2) * 2, 128);
  const file = join(tmpdir(), 'rp-console-e2e-camera.y4m');
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from(`YUV4MPEG2 W${String(WIDTH)} H${String(HEIGHT)} F30:1 Ip A1:1\nFRAME\n`),
      luma,
      chroma,
    ]),
  );
  return file;
}
