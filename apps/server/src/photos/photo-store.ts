import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { PhotoWidth } from '@rp/contracts';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Photo files under `<dataDir>/photos/<restaurantId>/<photoId>/<width>.webp` (P1-04). The storage
 * key is `<restaurantId>/<photoId>`. Paths are built only from UUIDs and known widths, and checked
 * to stay inside the store.
 */
export class PhotoStore {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = resolve(dataDir, 'photos');
  }

  static keyOf(restaurantId: string, photoId: string): string {
    if (!ID.test(restaurantId) || !ID.test(photoId)) throw new Error('Photo ids must be UUIDs');
    return `${restaurantId}/${photoId}`;
  }

  directoryOf(storageKey: string): string {
    const [restaurantId = '', photoId = '', ...rest] = storageKey.split('/');
    if (rest.length > 0 || !ID.test(restaurantId) || !ID.test(photoId)) {
      throw new Error('Invalid photo storage key');
    }
    const directory = join(this.root, restaurantId, photoId);
    if (!directory.startsWith(this.root + sep)) throw new Error('Invalid photo storage key');
    return directory;
  }

  fileOf(storageKey: string, width: PhotoWidth): string {
    return join(this.directoryOf(storageKey), `${String(width)}.webp`);
  }

  async write(
    storageKey: string,
    renditions: readonly { width: PhotoWidth; data: Buffer }[],
  ): Promise<void> {
    const directory = this.directoryOf(storageKey);
    await mkdir(directory, { recursive: true });
    await Promise.all(
      renditions.map((rendition) =>
        writeFile(join(directory, `${String(rendition.width)}.webp`), rendition.data),
      ),
    );
  }

  async exists(storageKey: string, width: PhotoWidth): Promise<boolean> {
    try {
      return (await stat(this.fileOf(storageKey, width))).isFile();
    } catch {
      return false;
    }
  }

  async remove(storageKey: string): Promise<void> {
    await rm(this.directoryOf(storageKey), { recursive: true, force: true });
  }

  /** Storage keys of every photo folder on disk, for finding files without a database row. */
  async keysOnDisk(): Promise<string[]> {
    const keys: string[] = [];
    const list = async (path: string) => {
      try {
        return await readdir(path, { withFileTypes: true });
      } catch {
        return [];
      }
    };
    for (const restaurant of await list(this.root)) {
      if (!restaurant.isDirectory() || !ID.test(restaurant.name)) continue;
      for (const photo of await list(join(this.root, restaurant.name))) {
        if (photo.isDirectory() && ID.test(photo.name)) {
          keys.push(`${restaurant.name}/${photo.name}`);
        }
      }
    }
    return keys;
  }
}
