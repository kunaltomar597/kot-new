import type { QrMenuDocument } from '@rp/contracts/relay';
import { IDS, MENU } from '@rp/ordering/testing';

export { IDS };

/** The shared test menu as a restaurant publishes it for its QR page. */
export function menuDocument(): QrMenuDocument {
  const onQr = new Set<string>([IDS.tikka, IDS.dal, IDS.thali, IDS.jamun, IDS.rasmalai]);
  return {
    restaurantName: 'Spice Route',
    accentColor: '#B4232A',
    timeZone: 'Asia/Kolkata',
    instructionMaxLength: 140,
    priceMode: 'TAX_EXCLUSIVE',
    serviceRequests: false,
    menu: {
      ...MENU,
      items: MENU.items.map((item) => ({
        ...item,
        channels: onQr.has(item.id)
          ? [...new Set([...item.channels, 'QR' as const])]
          : item.channels,
        ...(item.id === IDS.dal && {
          description: 'Black lentils slow-cooked overnight with butter.',
        }),
      })),
    },
    photos: [],
  };
}
