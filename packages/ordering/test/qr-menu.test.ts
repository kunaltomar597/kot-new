import { describe, expect, it } from 'vitest';
import { qrChannelMenu } from '../src/qr-menu.js';
import { IDS, MENU } from '../src/testing/menu-fixture.js';

const withQr = (ids: readonly string[]) => ({
  ...MENU,
  items: MENU.items.map((item) =>
    ids.includes(item.id) ? { ...item, channels: [...item.channels, 'QR' as const] } : item,
  ),
});

describe('[QR-002] [MENU-012] the menu the QR page offers', () => {
  it('keeps the QR dishes and what they use, and nothing else', () => {
    const menu = qrChannelMenu(withQr([IDS.tikka]));
    expect(menu.items.map((item) => item.id).sort()).toEqual([IDS.rasmalai, IDS.tikka].sort());
    expect(menu.modifierGroups.map((group) => group.id)).toEqual([IDS.extras]);
    expect(menu.categories.map((category) => category.id).sort()).toEqual(
      [IDS.starters, IDS.mains].sort(),
    );
    expect(menu.combos).toEqual([]);
    expect(menu.stations).toEqual([]);
    expect(menu.taxGroups.map((group) => group.id)).toEqual([IDS.tax]);
  });

  it('[MENU-005] keeps a QR combo with every part it may hold', () => {
    const menu = qrChannelMenu(withQr([IDS.thali]));
    expect(menu.combos.map((combo) => combo.itemId)).toEqual([IDS.thali]);
    expect(menu.items.map((item) => item.id).sort()).toEqual(
      [IDS.thali, IDS.dal, IDS.jamun, IDS.rasmalai].sort(),
    );
  });

  it('leaves archived dishes out', () => {
    const archived = withQr([IDS.dal]);
    archived.items = archived.items.map((item) =>
      item.id === IDS.dal ? { ...item, archived: true } : item,
    );
    expect(qrChannelMenu(archived).items.map((item) => item.id)).toEqual([IDS.rasmalai]);
  });

  it('[MENU-006] tells sold out, never how many are left', () => {
    const counted = withQr([IDS.dal, IDS.jamun]);
    counted.items = counted.items.map((item) =>
      item.id === IDS.dal ? { ...item, stockCount: 7 } : item,
    );
    const menu = qrChannelMenu(counted);
    expect(menu.items.find((item) => item.id === IDS.dal)?.stockCount).toBeNull();
    expect(menu.items.find((item) => item.id === IDS.jamun)?.stockCount).toBe(0);
  });
});
