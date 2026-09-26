import { createHash } from 'node:crypto';
import { PHOTO_MAX_BYTES, PHOTO_WIDTHS, type PhotoWidth } from '@rp/contracts';
import sharp from 'sharp';
import { AppError } from '../errors/app-error.js';

/** Formats accepted by their content (SEC-004). SVG, TIFF, GIF and raw are refused. */
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif']);

/** A decompression bomb guard: a 5 MB file may not unpack into more than this many pixels. */
export const PHOTO_MAX_PIXELS = 40_000_000;

const WEBP_QUALITY = 80;

export interface EncodedRendition {
  readonly width: PhotoWidth;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly data: Buffer;
}

export interface ProcessedPhoto {
  /** SHA-256 of the upload, hex. */
  readonly sha256: string;
  readonly renditions: readonly EncodedRendition[];
}

const unsupported = () =>
  new AppError(
    415,
    'PHOTO_UNSUPPORTED',
    'That file is not a photo we can use. Upload a JPEG, PNG, WebP or HEIF picture.',
  );

/**
 * Checks and re-encodes an upload (P1-04, MENU-008, SEC-004): the size, then the format as read
 * from the content, then the pixel count; the image is turned upright from its EXIF orientation
 * and written as WebP at each rendition width (never enlarged). The output carries no EXIF, ICC
 * or XMP metadata: sharp writes none unless asked.
 */
export async function processPhoto(content: Buffer): Promise<ProcessedPhoto> {
  if (content.length > PHOTO_MAX_BYTES) {
    throw new AppError(
      413,
      'PHOTO_TOO_LARGE',
      'The photo is larger than 5 MB. Use a smaller one.',
      {
        maxBytes: PHOTO_MAX_BYTES,
      },
    );
  }
  let metadata: { format: string; width: number; height: number };
  try {
    metadata = await sharp(content, { limitInputPixels: false }).metadata();
  } catch {
    throw unsupported();
  }
  if (!ACCEPTED_FORMATS.has(metadata.format)) throw unsupported();
  const pixels = metadata.width * metadata.height;
  if (pixels > PHOTO_MAX_PIXELS) {
    throw new AppError(
      413,
      'PHOTO_TOO_LARGE',
      'The photo has too many pixels. Use one under 40 megapixels.',
      { maxPixels: PHOTO_MAX_PIXELS },
    );
  }
  try {
    const renditions = await Promise.all(
      PHOTO_WIDTHS.map(async (width): Promise<EncodedRendition> => {
        const { data, info } = await sharp(content, { limitInputPixels: PHOTO_MAX_PIXELS })
          .rotate()
          .resize({ width, withoutEnlargement: true })
          .webp({ quality: WEBP_QUALITY })
          .toBuffer({ resolveWithObject: true });
        return { width, pixelWidth: info.width, pixelHeight: info.height, data };
      }),
    );
    return { sha256: createHash('sha256').update(content).digest('hex'), renditions };
  } catch {
    // A file that passes the header check but cannot be decoded (truncated, or HEIC compressed
    // with a codec the image library does not carry).
    throw unsupported();
  }
}
