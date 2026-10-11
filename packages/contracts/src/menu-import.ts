import { z } from 'zod';
import { Id, Paise } from './common.js';
import {
  MENU_EXTRACTION_MAX_FILES,
  MENU_EXTRACTION_TYPES,
  MenuExtractionView,
} from './control-plane/schemas.js';

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

// ---------------------------------------------------------------- AI-assisted import (P6-04b)

/** A phone photo may be large: the server makes it smaller before sending it on. */
export const AI_IMPORT_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
export const AI_IMPORT_PDF_MAX_BYTES = 20 * 1024 * 1024;
export const AI_IMPORT_MAX_BYTES = 40 * 1024 * 1024;

const approxBytes = (base64: string) => Math.floor((base64.length * 3) / 4);

/** ONB-006: photos or PDFs of the printed menu, to be read into a draft. */
export const AiMenuImportRequest = z
  .strictObject({
    files: z
      .array(
        z
          .strictObject({
            name: z.string().min(1).max(200),
            contentType: z.enum(MENU_EXTRACTION_TYPES),
            contentBase64: z
              .string()
              .min(4)
              .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Base64 without line breaks'),
          })
          .refine(
            (file) =>
              approxBytes(file.contentBase64) <=
              (file.contentType === 'application/pdf'
                ? AI_IMPORT_PDF_MAX_BYTES
                : AI_IMPORT_IMAGE_MAX_BYTES),
            { message: 'A photo may be at most 15 MB and a PDF 20 MB', path: ['contentBase64'] },
          ),
      )
      .min(1)
      .max(MENU_EXTRACTION_MAX_FILES),
  })
  .refine(
    (request) =>
      request.files.reduce((total, file) => total + approxBytes(file.contentBase64), 0) <=
      AI_IMPORT_MAX_BYTES,
    { message: 'The files may be at most 40 MB together', path: ['files'] },
  );
export type AiMenuImportRequest = z.infer<typeof AiMenuImportRequest>;

/** The import as the vendor's service reports it, with the draft once read (ONB-006). */
export const AiMenuImportView = MenuExtractionView.extend({});
export type AiMenuImportView = z.infer<typeof AiMenuImportView>;

export const AiMenuImportParams = z.strictObject({ importId: Id });
export type AiMenuImportParams = z.infer<typeof AiMenuImportParams>;

/** A dish as the manager checked it: what the menu said, corrected, and what it could not say. */
export const MenuReviewDish = z.strictObject({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable(),
  /** Null when its sizes carry the prices. */
  price: Paise.nullable(),
  variants: z
    .array(z.strictObject({ name: z.string().trim().min(1).max(40), price: Paise }))
    .max(10),
  foodType: z.enum(['VEG', 'NON_VEG', 'EGG']),
  spiceLevel: z.int().min(0).max(3),
  tags: z.array(z.string().trim().min(1).max(30)).max(10),
  taxGroupId: Id,
  stationId: Id,
  /** The manager looked at this dish (ONB-006: every one, before anything is imported). */
  checked: z.boolean(),
});
export type MenuReviewDish = z.infer<typeof MenuReviewDish>;

/** The reviewed draft, imported through the template's path (P1-05). */
export const MenuReviewRequest = z.strictObject({
  categories: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(60),
        items: z.array(MenuReviewDish).min(1).max(500),
      }),
    )
    .min(1)
    .max(60),
  /** Extras offered with many dishes, created as modifier groups to attach in the menu editor. */
  addOns: z
    .array(
      z.strictObject({
        group: z.string().trim().min(1).max(60),
        minSelections: z.int().min(0).max(20),
        maxSelections: z.int().min(1).max(20),
        options: z
          .array(z.strictObject({ name: z.string().trim().min(1).max(60), priceDelta: z.int() }))
          .min(1)
          .max(30),
      }),
    )
    .max(30),
});
export type MenuReviewRequest = z.infer<typeof MenuReviewRequest>;
