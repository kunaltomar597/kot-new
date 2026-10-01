import type { Content, DocumentDefinition } from 'pdfmake';
import type { TableTentSize } from '@rp/contracts';
import { pdfmake } from '../common/pdf.js';

/**
 * Printable table tents (P5-04, QR-001, ONB-004 step 10): the restaurant's name in its colour, the
 * table's QR code and label, and a line on what happens when the diner orders.
 * - A6: one card per page, for a stand or holder.
 * - A5: landscape, two A6 panels side by side; folded on the dashed line it stands as a tent with
 *   the code on both faces.
 * Printed for diners, in English for now (the QR site's language, OI-07).
 */

export interface TentTable {
  readonly label: string;
  readonly url: string;
}

export interface TentBranding {
  readonly restaurantName: string;
  /** "#RRGGBB"; dark slate when the restaurant has none. */
  readonly accentColor: string | null;
}

const INK = '#111827';
const MUTED = '#4B5563';

function panel(table: TentTable, branding: TentBranding): Content {
  return {
    stack: [
      {
        text: branding.restaurantName,
        fontSize: 16,
        bold: true,
        color: branding.accentColor ?? '#1F2937',
        alignment: 'center',
        margin: [0, 0, 0, 4],
      },
      {
        text: 'Scan to see the menu and order',
        fontSize: 10,
        color: INK,
        alignment: 'center',
        margin: [0, 0, 0, 10],
      },
      // Error correction M: still reads with a scuffed corner, and the code stays small.
      { qr: table.url, fit: 170, eccLevel: 'M', alignment: 'center', margin: [0, 0, 0, 10] },
      {
        text: `Table ${table.label}`,
        fontSize: 20,
        bold: true,
        color: INK,
        alignment: 'center',
        margin: [0, 0, 0, 6],
      },
      {
        text: 'No app needed. Your waiter confirms your order before it goes to the kitchen.',
        fontSize: 7.5,
        color: MUTED,
        alignment: 'center',
        margin: [0, 0, 0, 4],
      },
      { text: table.url, fontSize: 6, color: MUTED, alignment: 'center' },
    ],
  };
}

/** The tents as a PDF, one table per page, and the number of pages. */
export async function tableTentsPdf(
  tables: readonly TentTable[],
  branding: TentBranding,
  size: TableTentSize,
  stamp: { readonly generatedAt: string },
): Promise<{ pdf: Buffer; pages: number }> {
  const content: Content[] = tables.map((table, index): Content => {
    const pageBreak = index === 0 ? {} : { pageBreak: 'before' as const };
    if (size === 'A6')
      return { stack: [panel(table, branding)], margin: [0, 6, 0, 0], ...pageBreak };
    return {
      columns: [
        { ...panel(table, branding), width: '*' },
        { ...panel(table, branding), width: '*' },
      ],
      // Twice the page margin, so each panel sits centred on its half.
      columnGap: 48,
      ...pageBreak,
    };
  });
  const definition: DocumentDefinition = {
    pageSize: size,
    pageOrientation: size === 'A5' ? 'landscape' : 'portrait',
    pageMargins: size === 'A5' ? [24, 28, 24, 20] : [20, 24, 20, 20],
    info: {
      title: `${branding.restaurantName} table QR codes`,
      creator: 'Restaurant Operations Platform',
      subject: `Generated ${stamp.generatedAt}`,
    },
    // The fold line of a tent.
    ...(size === 'A5' && {
      background: (_page, page) => ({
        canvas: [
          {
            type: 'line',
            x1: page.width / 2,
            y1: 12,
            x2: page.width / 2,
            y2: page.height - 12,
            lineWidth: 0.5,
            lineColor: '#9CA3AF',
            dash: { length: 3 },
          },
        ],
      }),
    }),
    content,
    defaultStyle: { font: 'Roboto' },
  };
  return { pdf: await pdfmake.createPdf(definition).getBuffer(), pages: tables.length };
}
