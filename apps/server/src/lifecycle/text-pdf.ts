/**
 * A minimal PDF of monospaced text blocks (DATA-008, P7-06b): the archive's invoice books, a
 * year of invoices at design capacity in minutes. Courier (a PDF standard font, nothing
 * embedded), A4, two columns; a block never splits across columns unless it is taller than one.
 */

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 28;
const FONT_SIZE = 8;
const LEADING = 9.6;
const CHAR_WIDTH = FONT_SIZE * 0.6;
const GAP = 14;
const COLUMN_WIDTH = (PAGE_WIDTH - 2 * MARGIN - GAP) / 2;
/** Characters that fit a column. */
export const PDF_COLUMN_CHARS = Math.floor(COLUMN_WIDTH / CHAR_WIDTH);
const LINES_PER_COLUMN = Math.floor((PAGE_HEIGHT - 2 * MARGIN) / LEADING);

/** Text as WinAnsi bytes for a PDF string: the rupee sign as "Rs.", others as "?". */
function pdfString(text: string): string {
  const plain = text.replaceAll('₹', 'Rs.').replace(/[^\x20-\x7e]/g, '?');
  return `(${plain.replace(/[\\()]/g, (character) => `\\${character}`)})`;
}

/** Lays blocks of lines out into pages of two columns. */
export function layoutPages(blocks: readonly (readonly string[])[]): string[][][] {
  const pages: string[][][] = [];
  let page: string[][] = [[], []];
  let column = 0;
  const next = () => {
    column += 1;
    if (column > 1) {
      pages.push(page);
      page = [[], []];
      column = 0;
    }
  };
  for (const block of blocks) {
    const lines = block.map((line) => line.slice(0, PDF_COLUMN_CHARS));
    const current = page[column] ?? [];
    const room = LINES_PER_COLUMN - current.length;
    if (current.length > 0 && lines.length + 1 > room) next();
    for (const line of lines) {
      const target = page[column] ?? [];
      if (target.length >= LINES_PER_COLUMN) next();
      (page[column] ?? []).push(line);
    }
    const after = page[column] ?? [];
    if (after.length < LINES_PER_COLUMN) after.push('');
  }
  if ((page[0] ?? []).length > 0) pages.push(page);
  return pages;
}

/** The PDF file's bytes for these pages. */
export function textPdf(pages: readonly (readonly (readonly string[])[])[]): Buffer {
  const objects: string[] = [];
  // 1: catalogue, 2: pages, 3: font; then a page and its contents for each page.
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  const kids: string[] = [];
  pages.forEach((columns, index) => {
    const pageObject = 4 + index * 2;
    const contentObject = pageObject + 1;
    kids.push(`${String(pageObject)} 0 R`);
    let stream = `BT /F1 ${String(FONT_SIZE)} Tf ${String(LEADING)} TL\n`;
    columns.forEach((lines, columnIndex) => {
      const x = MARGIN + columnIndex * (COLUMN_WIDTH + GAP);
      stream += `1 0 0 1 ${x.toFixed(2)} ${(PAGE_HEIGHT - MARGIN - FONT_SIZE).toFixed(2)} Tm\n`;
      for (const line of lines) stream += `${pdfString(line)} Tj T*\n`;
    });
    stream += 'ET';
    objects[pageObject] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(PAGE_WIDTH)} ${String(PAGE_HEIGHT)}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${String(contentObject)} 0 R >>`;
    objects[contentObject] =
      `<< /Length ${String(Buffer.byteLength(stream, 'latin1'))} >>\nstream\n${stream}\nendstream`;
  });
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${String(pages.length)} >>`;
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let number = 1; number < objects.length; number += 1) {
    offsets[number] = Buffer.byteLength(body, 'latin1');
    body += `${String(number)} 0 obj\n${objects[number] ?? 'null'}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${String(objects.length)}\n0000000000 65535 f \n`;
  for (let number = 1; number < objects.length; number += 1) {
    body += `${String(offsets[number] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${String(objects.length)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
