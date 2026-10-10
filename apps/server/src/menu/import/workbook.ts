import { MENU_IMPORT_SHEETS, type MenuImportSheet, type MenuImportSheets } from '@rp/domain';
import readXlsxFile from 'read-excel-file/node';
import { unpackWorkbook } from './zip-limits.js';

export type WorkbookResult =
  | { readonly ok: true; readonly sheets: MenuImportSheets }
  | { readonly ok: false; readonly message: string };

const UNREADABLE = 'The workbook could not be read. Save it again as .xlsx from Excel.';

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * A cell as the text a person typed: numbers without float noise ("249.5"), dates as
 * YYYY-MM-DD, and a time-only cell (Excel keeps it on 30 Dec 1899) as HH:MM.
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    if (value.getUTCFullYear() < 1901)
      return `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}`;
    return `${String(value.getUTCFullYear())}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  if (typeof value === 'number') return String(Number(value.toPrecision(12)));
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value;
  return '';
}

/** Reads the template's sheets from a .xlsx; sheet names are matched without case. */
export async function readWorkbook(content: Buffer): Promise<WorkbookResult> {
  // Unpacked here within the limits (PC-D4); the reader gets the parts again, stored.
  const unpacked = await unpackWorkbook(content);
  if (!unpacked.ok) {
    return {
      ok: false,
      message:
        unpacked.reason === 'TOO_LARGE'
          ? 'The workbook unpacks to more than a menu needs. Remove other sheets or pictures.'
          : unpacked.reason === 'NOT_ZIP'
            ? 'The file is not an Excel workbook (.xlsx). Save it as .xlsx or send CSV sheets.'
            : UNREADABLE,
    };
  }
  let workbook: Awaited<ReturnType<typeof readXlsxFile>>;
  try {
    workbook = await readXlsxFile(unpacked.archive);
  } catch {
    return { ok: false, message: UNREADABLE };
  }
  const sheets: Partial<Record<MenuImportSheet, string[][]>> = {};
  for (const { sheet, data } of workbook) {
    const name = MENU_IMPORT_SHEETS.find(
      (known) => known.toLowerCase() === sheet.trim().toLowerCase(),
    );
    if (name === undefined || sheets[name] !== undefined) continue;
    sheets[name] = data.map((row) => row.map(cellText));
  }
  return { ok: true, sheets };
}
