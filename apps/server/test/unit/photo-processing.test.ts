import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHOTO_MAX_BYTES } from '@rp/contracts';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.js';
import { PHOTO_MAX_PIXELS, processPhoto } from '../../src/photos/photo-processing.js';
import { PhotoStore } from '../../src/photos/photo-store.js';

const image = (width: number, height: number) =>
  sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } },
  });

async function jpegWithExif(): Promise<Buffer> {
  return image(1200, 800)
    .withExif({ IFD0: { Make: 'TestCam', Model: 'Secret Phone', Copyright: 'Owner' } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return `${String(error.status)} ${error.code}`;
    throw error;
  }
  throw new Error('Expected a refusal');
}

describe('[MENU-008] [SEC-004] photo processing', () => {
  it('re-encodes a JPEG to WebP renditions without EXIF, turned upright', async () => {
    const input = await jpegWithExif();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const photo = await processPhoto(input);
    expect(photo.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(photo.renditions.map((rendition) => rendition.width)).toEqual([160, 480, 960]);
    for (const rendition of photo.renditions) {
      const metadata = await sharp(rendition.data).metadata();
      expect(metadata.format).toBe('webp');
      expect(metadata.exif).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(metadata.orientation).toBeUndefined();
      expect(rendition.data.includes(Buffer.from('Secret Phone'))).toBe(false);
      // Orientation 6 means the 1200 x 800 picture is really 800 wide and 1200 tall.
      expect(rendition.pixelHeight).toBeGreaterThan(rendition.pixelWidth);
    }
    expect(photo.renditions[2]).toMatchObject({ pixelWidth: 800, pixelHeight: 1200 });
    expect(photo.renditions[0]).toMatchObject({ pixelWidth: 160, pixelHeight: 240 });
  });

  it('accepts PNG, WebP and HEIF by content, whatever the file claims', async () => {
    for (const input of [
      await image(300, 200).png().toBuffer(),
      await image(300, 200).webp().toBuffer(),
      await image(300, 200).heif({ compression: 'av1' }).toBuffer(),
    ]) {
      const photo = await processPhoto(input);
      // Never enlarged: a 300 px picture stays 300 px in the larger renditions.
      expect(photo.renditions.map((rendition) => rendition.pixelWidth)).toEqual([160, 300, 300]);
    }
  });

  it('refuses what is not an accepted image: SVG, GIF, text and a truncated JPEG', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    );
    const gif = await image(10, 10).gif().toBuffer();
    const truncated = (await jpegWithExif()).subarray(0, 400);
    for (const input of [svg, gif, Buffer.from('hello, not a picture'), truncated]) {
      expect(await codeOf(processPhoto(input))).toBe('415 PHOTO_UNSUPPORTED');
    }
  });

  it('refuses a file over 5 MB and a picture with too many pixels', async () => {
    expect(await codeOf(processPhoto(Buffer.alloc(PHOTO_MAX_BYTES + 1)))).toBe(
      '413 PHOTO_TOO_LARGE',
    );
    // A small file that would unpack into 48 megapixels.
    const bomb = await image(8_000, 6_000).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.length).toBeLessThan(PHOTO_MAX_BYTES);
    expect(8_000 * 6_000).toBeGreaterThan(PHOTO_MAX_PIXELS);
    expect(await codeOf(processPhoto(bomb))).toBe('413 PHOTO_TOO_LARGE');
  });
});

describe('[MENU-008] photo store paths', () => {
  const restaurant = '0199a0e0-0000-7000-8000-000000000001';
  const photo = '0199a0e0-0000-7000-8000-000000000002';

  it('keeps every file inside the store and refuses anything but UUID keys', async () => {
    const store = new PhotoStore(await mkdtemp(join(tmpdir(), 'rp-photos-')));
    const key = PhotoStore.keyOf(restaurant, photo);
    expect(store.fileOf(key, 480)).toBe(join(store.root, restaurant, photo, '480.webp'));
    for (const bad of ['../etc/passwd', `${restaurant}/..`, `${restaurant}/${photo}/x`, '']) {
      expect(() => store.directoryOf(bad)).toThrow('Invalid photo storage key');
    }
    expect(() => PhotoStore.keyOf('..', photo)).toThrow();
    await store.write(key, [{ width: 160, data: Buffer.from('x') }]);
    expect(await store.exists(key, 160)).toBe(true);
    expect(await store.exists(key, 480)).toBe(false);
    expect(await store.keysOnDisk()).toEqual([key]);
    await store.remove(key);
    expect(await store.keysOnDisk()).toEqual([]);
  });
});
