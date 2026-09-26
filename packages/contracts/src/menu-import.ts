import { z } from 'zod';

/**
 * Menu import from the vendor template (P1-05, ONB-005, ONB-009): check a file and see every
 * problem with its sheet, row and column; then import it, which adds the menu in one transaction
 * and publishes a new menu version.
 */

/** Largest workbook accepted (a 150-item menu is well under 1 MB). */
export const MENU_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
/** Largest CSV text per sheet. */
const MAX_CSV_CHARS = 2 * 1024 * 1024;

export const MenuImportSheetName = z.enum(['Items', 'Variants', 'Modifiers', 'Combos']);
export type MenuImportSheetName = z.infer<typeof MenuImportSheetName>;

const Csv = z.string().max(MAX_CSV_CHARS);

/** The template as a workbook (.xlsx), or its sheets as CSV text (Items is required). */
export const MenuImportFile = z.discriminatedUnion('format', [
  z.strictObject({
    format: z.literal('XLSX'),
    contentBase64: z
      .string()
      .min(4)
      .max(Math.ceil(MENU_IMPORT_MAX_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Base64 without line breaks'),
  }),
  z.strictObject({
    format: z.literal('CSV'),
    sheets: z.strictObject({
      Items: Csv,
      Variants: Csv.optional(),
      Modifiers: Csv.optional(),
      Combos: Csv.optional(),
    }),
  }),
]);
export type MenuImportFile = z.infer<typeof MenuImportFile>;

export const MenuImportRequest = z.strictObject({ file: MenuImportFile });
export type MenuImportRequest = z.infer<typeof MenuImportRequest>;

export const MenuImportIssue = z.object({
  sheet: MenuImportSheetName,
  /** Spreadsheet row number (the header is row 1); null for the whole sheet or file. */
  row: z.int().positive().nullable(),
  column: z.string().nullable(),
  message: z.string(),
});
export type MenuImportIssue = z.infer<typeof MenuImportIssue>;

export const MenuImportSummary = z.object({
  categories: z.int().nonnegative(),
  modifierGroups: z.int().nonnegative(),
  items: z.int().nonnegative(),
  variants: z.int().nonnegative(),
  combos: z.int().nonnegative(),
});
export type MenuImportSummary = z.infer<typeof MenuImportSummary>;

export const MenuImportReport = z.object({
  /** True when the file has no problems. */
  ok: z.boolean(),
  /** True when the menu was written and published (import only, never for a check). */
  committed: z.boolean(),
  /** Every problem found, by sheet, then row, then column. Nothing is written when there are any. */
  issues: z.array(MenuImportIssue),
  /** What the import adds; null when there are problems. */
  summary: MenuImportSummary.nullable(),
  /** The published menu version after an import. */
  menuVersion: z.int().positive().nullable(),
});
export type MenuImportReport = z.infer<typeof MenuImportReport>;

export const MenuTemplateResponse = z.object({
  filename: z.string(),
  contentType: z.literal('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  contentBase64: z.string(),
});
export type MenuTemplateResponse = z.infer<typeof MenuTemplateResponse>;
