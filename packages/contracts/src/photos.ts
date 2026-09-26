import { z } from 'zod';
import { Id, Timestamp } from './common.js';

/**
 * Menu, logo and staff photos (P1-04, MENU-008, SEC-004). Photos are uploaded once, checked by
 * their content (not the name or claimed type), re-encoded to WebP renditions without EXIF, and
 * served to in-restaurant devices from the local server.
 */

/** Largest upload accepted, before encoding (MENU-008: 5 MB). */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/** Rendition widths in pixels: a thumbnail, a menu card and a full view. */
export const PHOTO_WIDTHS = [160, 480, 960] as const;
export type PhotoWidth = (typeof PHOTO_WIDTHS)[number];

/**
 * The image as base64 (JSON keeps the typed client and validation the same as every other
 * endpoint; the overhead is a third more bytes on the LAN). At most 5 MB once decoded.
 */
export const UploadPhotoRequest = z.strictObject({
  contentBase64: z
    .string()
    .min(4)
    .max(Math.ceil(PHOTO_MAX_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Base64 without line breaks'),
});
export type UploadPhotoRequest = z.infer<typeof UploadPhotoRequest>;

export const PhotoRendition = z.object({
  width: z.int().positive(),
  height: z.int().positive(),
  bytes: z.int().positive(),
  /** Path on the local server, e.g. `/api/v1/photos/{id}/480`. */
  url: z.string(),
});
export type PhotoRendition = z.infer<typeof PhotoRendition>;

export const PhotoView = z.object({
  id: Id,
  mimeType: z.literal('image/webp'),
  /** Size of the largest rendition. */
  width: z.int().positive(),
  height: z.int().positive(),
  /** One per `PHOTO_WIDTHS`, smallest first; an image narrower than a width is not enlarged. */
  renditions: z.array(PhotoRendition),
  createdAt: Timestamp,
});
export type PhotoView = z.infer<typeof PhotoView>;

export const PhotoRenditionParams = z.strictObject({
  id: Id,
  width: z.enum(['160', '480', '960']),
});
export type PhotoRenditionParams = z.infer<typeof PhotoRenditionParams>;

/** The URL of one rendition, for `<img src>`. */
export function photoUrl(id: string, width: PhotoWidth): string {
  return `/api/v1/photos/${id}/${String(width)}`;
}
