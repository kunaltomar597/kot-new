/**
 * GSTIN (GST Identification Number) validation for the restaurant profile and B2B invoices
 * (BILL-002, ONB-004): 15 characters, the state code, the holder's PAN, an entity number, `Z`
 * and a check character computed over the first 14 (the GST portal's mod-36 checksum).
 */

const CHARACTERS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** The shape of a GSTIN (the check character is verified separately). */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** GST state and union-territory codes (place of supply), as the GST portal numbers them. */
export const GST_STATE_CODES: Readonly<Record<string, string>> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu (before 2020)',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh (before 2014)',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

/** The check character for the first 14 characters of a GSTIN. */
export function gstinCheckCharacter(first14: string): string {
  let sum = 0;
  for (let index = 0; index < 14; index += 1) {
    const value = CHARACTERS.indexOf(first14.charAt(index));
    const product = value * (index % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARACTERS.charAt((36 - (sum % 36)) % 36);
}

export type GstinProblem = 'FORMAT' | 'STATE_CODE' | 'CHECKSUM';

/** Why a GSTIN is not valid, or undefined when it is. Expects upper case without spaces. */
export function gstinProblem(gstin: string): GstinProblem | undefined {
  if (!GSTIN_PATTERN.test(gstin)) return 'FORMAT';
  if (GST_STATE_CODES[gstin.slice(0, 2)] === undefined) return 'STATE_CODE';
  if (gstinCheckCharacter(gstin.slice(0, 14)) !== gstin.charAt(14)) return 'CHECKSUM';
  return undefined;
}

export function isValidGstin(gstin: string): boolean {
  return gstinProblem(gstin) === undefined;
}

/** `27aapfu 0939f1zv` → `27AAPFU0939F1ZV` (what people type or paste). */
export function normaliseGstin(input: string): string {
  return input.toUpperCase().replace(/\s+/g, '');
}
