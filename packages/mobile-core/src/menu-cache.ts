import { MenuSnapshot } from '@rp/contracts';
import { type KeyValueStore, readJson } from './storage.js';

const STORAGE_KEY = 'rp.menu.v1';

/**
 * The published menu kept on the device (MENU-013): shown at once on start, even offline, and
 * fetched again when a newer version is published (`MenuPublished`) or on reconnect. Availability
 * changes arrive as events and are applied on top (MENU-006).
 */
export class MenuCache {
  private current: MenuSnapshot | null | undefined;

  constructor(private readonly store: KeyValueStore) {}

  async get(): Promise<MenuSnapshot | null> {
    if (this.current !== undefined) return this.current;
    this.current = await readJson(this.store, STORAGE_KEY, (value) => MenuSnapshot.parse(value));
    return this.current;
  }

  /**
   * Fetches the menu when there is none yet, when `announcedVersion` is newer than the cached one,
   * or when `force` is set (after reconnecting). Returns the menu and whether it changed.
   */
  async refresh(
    fetchMenu: () => Promise<MenuSnapshot>,
    options: { announcedVersion?: number; force?: boolean } = {},
  ): Promise<{ menu: MenuSnapshot; changed: boolean }> {
    const cached = await this.get();
    const stale =
      cached === null ||
      options.force === true ||
      (options.announcedVersion !== undefined && options.announcedVersion > cached.version);
    if (!stale) return { menu: cached, changed: false };
    const fresh = await fetchMenu();
    const changed = cached === null || JSON.stringify(cached) !== JSON.stringify(fresh);
    if (changed) await this.put(fresh);
    return { menu: changed ? fresh : cached, changed };
  }

  /** An item's availability or stock changed (MENU-006); unknown items are ignored. */
  async applyAvailability(change: {
    itemId: string;
    available: boolean;
    stockCount: number | null;
  }): Promise<MenuSnapshot | null> {
    const cached = await this.get();
    if (cached === null) return null;
    const updated: MenuSnapshot = {
      ...cached,
      items: cached.items.map((item) =>
        item.id === change.itemId
          ? { ...item, available: change.available, stockCount: change.stockCount }
          : item,
      ),
    };
    await this.put(updated);
    return updated;
  }

  async clear(): Promise<void> {
    this.current = null;
    await this.store.removeItem(STORAGE_KEY);
  }

  private async put(menu: MenuSnapshot): Promise<void> {
    this.current = menu;
    await this.store.setItem(STORAGE_KEY, JSON.stringify(menu));
  }
}
