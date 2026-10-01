import type { QrMenuDocument } from '@rp/contracts/relay';
import { IDS, MENU } from '@rp/ordering/testing';

export { IDS };

/** Masala Chai: on the POS only, so the QR page can never order it. */
export const POS_ONLY = '0199a0e0-0000-7000-8000-000000000070';

/**
 * The shared test menu as a restaurant would publish it for its QR page: Paneer Tikka (sizes,
 * extras), Dal Makhani and the thali combo on the QR channel; Gulab Jamun out of stock; Rasmalai
 * QR only; Masala Chai at the POS only.
 */
export function qrMenuDocument(overrides: Partial<QrMenuDocument> = {}): QrMenuDocument {
  const onQr = new Set<string>([IDS.tikka, IDS.dal, IDS.thali, IDS.jamun]);
  return {
    restaurantName: 'Spice Route',
    accentColor: '#B4232A',
    timeZone: 'Asia/Kolkata',
    instructionMaxLength: 140,
    serviceRequests: true,
    menu: {
      ...MENU,
      items: [
        ...MENU.items.map((item) =>
          onQr.has(item.id)
            ? {
                ...item,
                channels: [...item.channels, 'QR' as const],
                ...(item.id === IDS.jamun && { available: false }),
              }
            : item,
        ),
        { ...MENU.items[1]!, id: POS_ONLY, name: 'Masala Chai', channels: ['POS'] },
      ],
    },
    photos: [],
    ...overrides,
  };
}
