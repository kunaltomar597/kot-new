import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  APP_BUILDS_FILE,
  type AppBuildKind,
  AppBuildsFile,
  type AppBuildStatus,
  type AppBuildView,
} from '@rp/contracts';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import type { DeviceType } from '../generated/prisma/enums.js';

/** An APK named in `apps.json`, with how it stands and where it is. */
export interface CheckedAppBuild {
  readonly view: AppBuildView;
  readonly status: AppBuildStatus;
  readonly path: string;
}

/** The app a paired device runs, for the device types that are Android apps. */
export function appKindOfDevice(type: DeviceType): AppBuildKind | undefined {
  if (type === 'WAITER_PHONE') return 'waiter-app';
  if (type === 'TABLE_TABLET') return 'table-tablet';
  return undefined;
}

interface FileState {
  readonly size: number;
  readonly mtimeMs: number;
}

async function fileState(path: string): Promise<FileState | undefined> {
  try {
    const found = await stat(path);
    return found.isFile() ? { size: found.size, mtimeMs: found.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

const sameState = (a: FileState | undefined, b: FileState | undefined) =>
  a?.size === b?.size && a?.mtimeMs === b?.mtimeMs;

/**
 * The phone and tablet APKs this PC serves (WTR-001, UPD-001, UPD-007, P7-04e2). The installer
 * puts the release's APKs and their `apps.json` in `<install>\apps` (`RP_APPS_DIR`); only
 * administrators can write there. Before offering an APK the server checks its size and SHA-256
 * against `apps.json`; a damaged or missing one is not offered and shows on the System page. The
 * hashes are worked out again only when a file changes.
 */
@Injectable()
export class AppBuildsService {
  private readonly logger = new Logger(AppBuildsService.name);
  private checked:
    | {
        readonly manifest: FileState;
        readonly files: readonly (FileState | undefined)[];
        readonly builds: readonly CheckedAppBuild[];
      }
    | undefined;
  private running: Promise<readonly CheckedAppBuild[]> | undefined;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Every APK in the release with its state; empty without an apps folder or `apps.json`. */
  list(): Promise<readonly CheckedAppBuild[]> {
    this.running ??= this.check().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** The build of an app that passed its check, or undefined. */
  async forKind(kind: AppBuildKind): Promise<CheckedAppBuild | undefined> {
    return (await this.list()).find((build) => build.view.kind === kind && build.status === 'OK');
  }

  private async check(): Promise<readonly CheckedAppBuild[]> {
    const dir = this.config.appsDir;
    if (dir === undefined) return [];
    const manifestPath = join(dir, APP_BUILDS_FILE);
    const manifestState = await fileState(manifestPath);
    if (manifestState === undefined) return [];
    const file = await this.readManifest(manifestPath);
    if (file === undefined) return [];
    const paths = file.apps.map((app) => join(dir, app.file));
    const states = await Promise.all(paths.map(fileState));
    const previous = this.checked;
    if (
      previous !== undefined &&
      sameState(previous.manifest, manifestState) &&
      previous.files.length === states.length &&
      previous.files.every((state, index) => sameState(state, states[index]))
    ) {
      return previous.builds;
    }
    const builds = await Promise.all(
      file.apps.map(async (app, index): Promise<CheckedAppBuild> => {
        const { file: _file, ...view } = app;
        const path = paths[index] ?? '';
        const state = states[index];
        let status: AppBuildStatus = 'OK';
        if (state === undefined) status = 'MISSING';
        else if (state.size !== app.sizeBytes || (await sha256Of(path)) !== app.sha256) {
          status = 'DAMAGED';
        }
        if (status !== 'OK') {
          this.logger.warn(
            { kind: app.kind, version: app.version, status },
            'An APK on this PC failed its check and is not offered',
          );
        }
        return { view, status, path };
      }),
    );
    this.checked = { manifest: manifestState, files: states, builds };
    return builds;
  }

  private async readManifest(path: string): Promise<AppBuildsFile | undefined> {
    try {
      const parsed = AppBuildsFile.safeParse(JSON.parse(await readFile(path, 'utf8')));
      if (parsed.success) return parsed.data;
      this.logger.error(
        { problems: parsed.error.issues.length },
        `${APP_BUILDS_FILE} is not valid`,
      );
    } catch (error) {
      this.logger.error({ err: error }, `${APP_BUILDS_FILE} could not be read`);
    }
    return undefined;
  }
}
