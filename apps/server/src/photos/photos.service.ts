import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  PHOTO_MAX_BYTES,
  photoUrl,
  type PhotoView,
  type PhotoWidth,
  type UploadPhotoRequest,
} from '@rp/contracts';
import { stat } from 'node:fs/promises';
import type { Principal } from '../auth/principal.js';
import { newId } from '../common/ids.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { SettingsService } from '../settings/settings.service.js';
import { processPhoto } from './photo-processing.js';
import { PhotoStore } from './photo-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The first clean-up runs a while after start, then once a day. */
const FIRST_PURGE_DELAY_MS = 10 * 60 * 1000;
/** Folders without a database row are left alone this long (an upload may be in flight). */
const STRAY_FOLDER_GRACE_MS = DAY_MS;

interface PhotoRow {
  id: string;
  storageKey: string;
  width: number;
  height: number;
  createdAt: Date;
}

/** Every `photoId` string anywhere in a published menu snapshot. */
function photoIdsIn(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) photoIdsIn(entry, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'photoId' && typeof entry === 'string') into.add(entry);
      else photoIdsIn(entry, into);
    }
  }
}

export interface PurgeResult {
  readonly photos: number;
  readonly strayFolders: number;
}

/**
 * Photos (P1-04, MENU-008): upload with checks and re-encoding, the renditions' files, and the
 * daily clean-up of photos nothing uses (DATA-007).
 */
@Injectable()
export class PhotosService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PhotosService.name);
  readonly store: PhotoStore;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {
    this.store = new PhotoStore(config.dataDir);
  }

  onApplicationBootstrap(): void {
    this.schedule(FIRST_PURGE_DELAY_MS);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  async upload(principal: Principal, request: UploadPhotoRequest): Promise<PhotoView> {
    const content = Buffer.from(request.contentBase64, 'base64');
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
    const processed = await processPhoto(content);
    const id = newId();
    const storageKey = PhotoStore.keyOf(principal.restaurantId, id);
    const largest = processed.renditions.at(-1);
    if (largest === undefined) throw new Error('No renditions were produced');
    await this.store.write(storageKey, processed.renditions);
    try {
      const row = await this.prisma.photo.create({
        data: {
          id,
          restaurantId: principal.restaurantId,
          storageKey,
          mimeType: 'image/webp',
          width: largest.pixelWidth,
          height: largest.pixelHeight,
          bytes: processed.renditions.reduce(
            (total, rendition) => total + rendition.data.length,
            0,
          ),
          sha256: processed.sha256,
        },
      });
      return {
        id: row.id,
        mimeType: 'image/webp',
        width: row.width,
        height: row.height,
        renditions: processed.renditions.map((rendition) => ({
          width: rendition.pixelWidth,
          height: rendition.pixelHeight,
          bytes: rendition.data.length,
          url: photoUrl(row.id, rendition.width),
        })),
        createdAt: row.createdAt.toISOString(),
      };
    } catch (error) {
      await this.store.remove(storageKey);
      throw error;
    }
  }

  /** The file of one rendition. Any restaurant's photo: the id is the secret-free handle. */
  async renditionFile(id: string, width: PhotoWidth): Promise<string> {
    const photo = await this.prisma.photo.findUnique({
      where: { id },
      select: { storageKey: true },
    });
    if (photo === null || !(await this.store.exists(photo.storageKey, width))) {
      throw new AppError(404, 'PHOTO_NOT_FOUND', 'There is no such photo.');
    }
    return this.store.fileOf(photo.storageKey, width);
  }

  /**
   * Removes photos uploaded more than `retention.operationalDays` ago that no item, staff member,
   * logo or the current published menu uses (DATA-007), and photo folders left without a record.
   * A photo taken off an item is kept until it is that old.
   */
  async purgeUnused(now: Date = new Date()): Promise<PurgeResult> {
    let photos = 0;
    const restaurants = await this.prisma.restaurant.findMany({
      select: { id: true, logoPhotoId: true },
    });
    for (const restaurant of restaurants) {
      const settings = await this.settings.snapshot(restaurant.id);
      const cutoff = new Date(now.getTime() - settings.get('retention.operationalDays') * DAY_MS);
      const old: PhotoRow[] = await this.prisma.photo.findMany({
        where: { restaurantId: restaurant.id, createdAt: { lt: cutoff } },
        select: { id: true, storageKey: true, width: true, height: true, createdAt: true },
      });
      if (old.length === 0) continue;
      const inUse = await this.photosInUse(restaurant.id, restaurant.logoPhotoId);
      for (const photo of old) {
        if (inUse.has(photo.id)) continue;
        await this.prisma.photo.delete({ where: { id: photo.id } });
        await this.store.remove(photo.storageKey);
        photos += 1;
      }
    }
    const known = new Set(
      (await this.prisma.photo.findMany({ select: { storageKey: true } })).map(
        (photo) => photo.storageKey,
      ),
    );
    let strayFolders = 0;
    for (const key of await this.store.keysOnDisk()) {
      if (known.has(key)) continue;
      const modified = (await stat(this.store.directoryOf(key))).mtime;
      if (now.getTime() - modified.getTime() < STRAY_FOLDER_GRACE_MS) continue;
      await this.store.remove(key);
      strayFolders += 1;
    }
    return { photos, strayFolders };
  }

  private async photosInUse(
    restaurantId: string,
    logoPhotoId: string | null,
  ): Promise<Set<string>> {
    const [items, staff, menu] = await Promise.all([
      this.prisma.item.findMany({
        where: { restaurantId, photoId: { not: null } },
        select: { photoId: true },
      }),
      this.prisma.staff.findMany({
        where: { restaurantId, photoId: { not: null } },
        select: { photoId: true },
      }),
      this.prisma.menuVersion.findFirst({
        where: { restaurantId },
        orderBy: { version: 'desc' },
        select: { snapshot: true },
      }),
    ]);
    const inUse = new Set<string>();
    if (logoPhotoId !== null) inUse.add(logoPhotoId);
    for (const row of [...items, ...staff]) if (row.photoId !== null) inUse.add(row.photoId);
    photoIdsIn(menu?.snapshot, inUse);
    return inUse;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.purgeUnused()
        .then(
          (result) => {
            if (result.photos + result.strayFolders > 0) {
              this.logger.log(`Removed ${String(result.photos)} unused photos`);
            }
          },
          (error: unknown) => {
            this.logger.error(`Photo clean-up failed: ${String(error)}`);
          },
        )
        .finally(() => {
          this.schedule(DAY_MS);
        });
    }, delayMs);
    this.timer.unref();
  }
}
