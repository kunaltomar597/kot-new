import { z } from 'zod';
import { ClientApiVersionText } from './client-api.js';

/**
 * The phone and tablet builds (APKs) a restaurant PC serves (UPD-001, WTR-001, P7-04e2). The
 * release's APKs travel in the PC's installer, so each PC serves the builds of its own release
 * and phones and tablets update after their PC (ADR-0017). A device downloads its own app's APK
 * from the PC over the pinned LAN CA, checks its SHA-256 and hands it to Android, which installs
 * it only over an app signed with the same key.
 */

/** The apps delivered as APKs: the waiter app and the table tablet. */
export const APP_BUILD_KINDS = ['waiter-app', 'table-tablet'] as const;
export const AppBuildKind = z.enum(APP_BUILD_KINDS);
export type AppBuildKind = z.infer<typeof AppBuildKind>;

/** The file beside the APKs in the install folder's `apps` (written by the packaging step). */
export const APP_BUILDS_FILE = 'apps.json';

/** What an APK is sent as. */
export const APK_MEDIA_TYPE = 'application/vnd.android.package-archive';

/** The largest APK a PC serves (a React Native release is about 60 MB). */
export const MAX_APK_BYTES = 300 * 1024 * 1024;

/** A file's SHA-256, lower-case hex. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

const AppVersion = z
  .string()
  .max(64)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/);

/**
 * `apps.json` in the install folder's `apps` (`package:stage --apk`): each APK of the release
 * with what the PC checks before offering it.
 */
export const AppBuildsFile = z.strictObject({
  format: z.literal(1),
  /** The RESTAURANT_PC release whose installer carries them. */
  release: z.string().min(1).max(64),
  apps: z
    .array(
      z.strictObject({
        kind: AppBuildKind,
        /** The app's version (its `package.json`, which the build takes). */
        version: AppVersion,
        /** The client API its JavaScript speaks. */
        clientApi: ClientApiVersionText,
        /** The APK's name in the same folder, e.g. `waiter-app-1.4.0.apk`. */
        file: z.string().regex(/^[a-z][a-z0-9-]{0,39}-[0-9A-Za-z.+-]{1,64}\.apk$/),
        sha256: Sha256Hex,
        sizeBytes: z.int().positive().max(MAX_APK_BYTES),
      }),
    )
    .max(APP_BUILD_KINDS.length)
    .refine(
      (apps) => new Set(apps.map((app) => app.kind)).size === apps.length,
      'One build per app',
    ),
});
export type AppBuildsFile = z.infer<typeof AppBuildsFile>;

/** One APK the PC offers. */
export const AppBuildView = z.object({
  kind: AppBuildKind,
  version: AppVersion,
  clientApi: ClientApiVersionText,
  sha256: Sha256Hex,
  sizeBytes: z.int().positive(),
});
export type AppBuildView = z.infer<typeof AppBuildView>;

/**
 * The build of the calling device's app on this PC, or null: none in this release, the APK on the
 * PC failed its check, or the device is not a phone or tablet.
 */
export const CurrentAppBuildResponse = z.object({ build: AppBuildView.nullable() });
export type CurrentAppBuildResponse = z.infer<typeof CurrentAppBuildResponse>;

/**
 * How an APK on the PC stands: `OK` (offered), `MISSING` (named in `apps.json` but not there) or
 * `DAMAGED` (its size or SHA-256 differs from `apps.json`); only `OK` builds are offered.
 */
export const AppBuildStatus = z.enum(['OK', 'MISSING', 'DAMAGED']);
export type AppBuildStatus = z.infer<typeof AppBuildStatus>;

/** An APK on the PC, for the System page. */
export const SystemAppBuild = AppBuildView.extend({ status: AppBuildStatus });
export type SystemAppBuild = z.infer<typeof SystemAppBuild>;
