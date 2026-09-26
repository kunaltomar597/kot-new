import { toLocalDateTime } from '@rp/domain';

/**
 * ESC/POS rendering for kitchen tickets and test pages (P1-07a, KDS-008). Pure: it turns a ticket
 * into the bytes a thermal printer takes, so it is tested byte for byte without a printer.
 *
 * Only the commands every ESC/POS printer understands are used: initialise, alignment, bold,
 * character size, line feed and cut. Text is reduced to printable ASCII, because the code page
 * differs from printer to printer and a wrong guess prints garbage in the kitchen.
 */

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

const INIT = [ESC, 0x40];
const ALIGN_LEFT = [ESC, 0x61, 0];
const ALIGN_CENTRE = [ESC, 0x61, 1];
const BOLD_ON = [ESC, 0x45, 1];
const BOLD_OFF = [ESC, 0x45, 0];
const SIZE_NORMAL = [GS, 0x21, 0x00];
const SIZE_DOUBLE = [GS, 0x21, 0x11];
const SIZE_TALL = [GS, 0x21, 0x01];
/** Feed three lines so the last text clears the cutter, then a partial cut. */
const FEED_AND_CUT = [GS, 0x56, 0x42, 0x03];

export type PaperWidthMm = 58 | 80;

/** Rows written before P1-07a could hold any width; anything but 58 prints as 80 mm. */
export function paperWidthOf(printer: { readonly paperWidthMm: number }): PaperWidthMm {
  return printer.paperWidthMm === 58 ? 58 : 80;
}

/** Characters per line in the printer's standard font (font A, 12 x 24 dots). */
export function charactersPerLine(paperWidthMm: PaperWidthMm): number {
  return paperWidthMm === 58 ? 32 : 48;
}

export interface KotTicketModifier {
  readonly name: string;
  readonly quantity: number;
}

export interface KotTicketLine {
  /** Negative on a MODIFIED ticket that reduces a line. */
  readonly quantity: number;
  readonly name: string;
  readonly variantName: string | null;
  readonly modifiers: readonly KotTicketModifier[];
  readonly instructions: string | null;
  /** The combo this line is part of, so the kitchen sees what belongs together. */
  readonly comboName: string | null;
}

export interface KotTicket {
  readonly kind: 'NEW' | 'MODIFIED' | 'CANCELLED';
  readonly kotNumber: number;
  readonly orderNumber: number;
  readonly stationName: string;
  /** Table label for dine-in, token for takeaway (TBL-008). */
  readonly destination:
    | { readonly type: 'TABLE'; readonly label: string }
    | { readonly type: 'TAKEAWAY'; readonly token: number | null };
  readonly waiterName: string | null;
  readonly source: 'POS' | 'WAITER_APP' | 'TABLE_TABLET' | 'QR';
  readonly createdAt: Date;
  readonly timeZone: string;
  readonly lines: readonly KotTicketLine[];
  /** Printed again on request or on another printer (KDS-008). */
  readonly reprint: boolean;
}

const SOURCE_LABELS: Readonly<Record<KotTicket['source'], string>> = {
  POS: 'POS',
  WAITER_APP: 'Waiter app',
  TABLE_TABLET: 'Table tablet',
  QR: 'QR',
};

const KIND_BANNERS: Readonly<Record<KotTicket['kind'], string | null>> = {
  NEW: null,
  MODIFIED: '** CHANGED **',
  CANCELLED: '** CANCELLED **',
};

/** Printable ASCII only: accents are dropped, anything else becomes "?". */
export function toPrintable(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7e]/g, '?');
}

/** Breaks text into lines of at most `width` characters, at spaces where it can. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of toPrintable(text)
    .split(' ')
    .filter((part) => part !== '')) {
    let rest = word;
    while (rest.length > 0) {
      const room = current === '' ? width : width - current.length - 1;
      if (rest.length <= room) {
        current = current === '' ? rest : `${current} ${rest}`;
        rest = '';
      } else if (current !== '') {
        lines.push(current);
        current = '';
      } else {
        lines.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
    }
  }
  if (current !== '') lines.push(current);
  return lines.length === 0 ? [''] : lines;
}

/** `left` and `right` on one line, `right` flush right; `left` is shortened if both do not fit. */
function spread(left: string, right: string, width: number): string {
  const safeRight = toPrintable(right).slice(0, width);
  const room = Math.max(width - safeRight.length - 1, 0);
  const safeLeft = toPrintable(left).slice(0, room);
  return `${safeLeft}${' '.repeat(width - safeLeft.length - safeRight.length)}${safeRight}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** "26-09-2026 13:05" in the restaurant's time zone (timestamps are shown in IST). */
export function formatLocal(instant: Date, timeZone: string): string {
  const local = toLocalDateTime(instant, timeZone);
  return `${pad2(local.day)}-${pad2(local.month)}-${String(local.year)} ${pad2(local.hour)}:${pad2(local.minute)}`;
}

class Receipt {
  private readonly bytes: number[] = [...INIT];

  command(sequence: readonly number[]): this {
    this.bytes.push(...sequence);
    return this;
  }

  line(text = ''): this {
    for (const char of toPrintable(text)) this.bytes.push(char.charCodeAt(0));
    this.bytes.push(LF);
    return this;
  }

  lines(texts: readonly string[]): this {
    for (const text of texts) this.line(text);
    return this;
  }

  finish(): Uint8Array {
    return Uint8Array.from([...this.bytes, ...FEED_AND_CUT]);
  }
}

function destinationText(destination: KotTicket['destination']): string {
  if (destination.type === 'TABLE') return `TABLE ${destination.label}`;
  return destination.token === null ? 'TAKEAWAY' : `TAKEAWAY #${String(destination.token)}`;
}

function quantityText(quantity: number): string {
  return `${String(quantity)} x `;
}

/**
 * A kitchen order ticket (ORD-007, KDS-008): the table or token large at the top so the pass can
 * read it from a distance, a banner when it changes an earlier ticket, then one block per line
 * with its variant, modifiers and instructions.
 */
export function renderKotTicket(ticket: KotTicket, paperWidthMm: PaperWidthMm): Uint8Array {
  const width = charactersPerLine(paperWidthMm);
  const doubleWidth = Math.floor(width / 2);
  const receipt = new Receipt();

  receipt.command(ALIGN_CENTRE).command(SIZE_DOUBLE).command(BOLD_ON);
  receipt.lines(wrap(destinationText(ticket.destination), doubleWidth));
  const banner = KIND_BANNERS[ticket.kind];
  if (banner !== null) receipt.lines(wrap(banner, doubleWidth));
  if (ticket.reprint) receipt.lines(wrap('REPRINT', doubleWidth));
  receipt.command(SIZE_NORMAL).command(BOLD_OFF);
  receipt.lines(wrap(ticket.stationName, width));

  receipt.command(ALIGN_LEFT);
  receipt.line(
    spread(`KOT ${String(ticket.kotNumber)}`, `Order ${String(ticket.orderNumber)}`, width),
  );
  receipt.line(
    spread(
      ticket.waiterName === null ? '' : `Waiter: ${ticket.waiterName}`,
      SOURCE_LABELS[ticket.source],
      width,
    ),
  );
  receipt.line(formatLocal(ticket.createdAt, ticket.timeZone));
  receipt.line('-'.repeat(width));

  for (const item of ticket.lines) {
    const quantity = quantityText(item.quantity);
    const indent = ' '.repeat(quantity.length);
    const name = item.variantName === null ? item.name : `${item.name} (${item.variantName})`;
    const nameLines = wrap(name, width - quantity.length);
    receipt.command(SIZE_TALL).command(BOLD_ON);
    receipt.lines(nameLines.map((text, index) => `${index === 0 ? quantity : indent}${text}`));
    receipt.command(SIZE_NORMAL).command(BOLD_OFF);
    for (const modifier of item.modifiers) {
      const label =
        modifier.quantity === 1 ? modifier.name : `${modifier.name} x${String(modifier.quantity)}`;
      receipt.lines(wrap(`+ ${label}`, width - indent.length).map((text) => `${indent}${text}`));
    }
    if (item.instructions !== null && item.instructions.trim() !== '') {
      receipt.lines(
        wrap(`! ${item.instructions}`, width - indent.length).map((text) => `${indent}${text}`),
      );
    }
    if (item.comboName !== null) {
      receipt.lines(
        wrap(`(part of ${item.comboName})`, width - indent.length).map(
          (text) => `${indent}${text}`,
        ),
      );
    }
  }

  receipt.line('-'.repeat(width));
  const count = ticket.lines.reduce((sum, item) => sum + Math.abs(item.quantity), 0);
  receipt.line(spread(`${String(ticket.lines.length)} lines`, `${String(count)} items`, width));
  return receipt.finish();
}

export interface TestPage {
  readonly restaurantName: string;
  readonly printerName: string;
  readonly paperWidthMm: PaperWidthMm;
  readonly at: Date;
  readonly timeZone: string;
}

/**
 * The test page for setup (ONB-004 step 6): says which printer it came from, and a ruler across
 * the full width so the installer can confirm the paper width matches the printer.
 */
export function renderTestPage(page: TestPage): Uint8Array {
  const width = charactersPerLine(page.paperWidthMm);
  const ruler = Array.from({ length: width }, (_, index) => String((index + 1) % 10)).join('');
  return new Receipt()
    .command(ALIGN_CENTRE)
    .command(SIZE_DOUBLE)
    .command(BOLD_ON)
    .lines(wrap('TEST PAGE', Math.floor(width / 2)))
    .command(SIZE_NORMAL)
    .command(BOLD_OFF)
    .lines(wrap(page.restaurantName, width))
    .command(ALIGN_LEFT)
    .line('-'.repeat(width))
    .lines(wrap(`Printer: ${page.printerName}`, width))
    .line(`Paper: ${String(page.paperWidthMm)} mm, ${String(width)} characters`)
    .line(formatLocal(page.at, page.timeZone))
    .line(ruler)
    .line('-'.repeat(width))
    .lines(wrap('If this page printed in full, the printer is ready.', width))
    .finish();
}

export interface PrintNoticePage {
  /** Large heading, e.g. "MOVED". */
  readonly title: string;
  readonly lines: readonly string[];
  readonly stationName: string;
  readonly createdAt: Date;
  readonly timeZone: string;
}

/**
 * A note for a station that is not a ticket to cook from, e.g. "Moved from T4 to T7" when a table
 * moves (TBL-005: the tickets already printed stay valid, so they are not printed again).
 */
export function renderNotice(notice: PrintNoticePage, paperWidthMm: PaperWidthMm): Uint8Array {
  const width = charactersPerLine(paperWidthMm);
  return new Receipt()
    .command(ALIGN_CENTRE)
    .command(SIZE_DOUBLE)
    .command(BOLD_ON)
    .lines(wrap(notice.title, Math.floor(width / 2)))
    .command(SIZE_NORMAL)
    .command(BOLD_OFF)
    .lines(wrap(notice.stationName, width))
    .command(ALIGN_LEFT)
    .line('-'.repeat(width))
    .command(SIZE_TALL)
    .command(BOLD_ON)
    .lines(notice.lines.flatMap((text) => wrap(text, width)))
    .command(SIZE_NORMAL)
    .command(BOLD_OFF)
    .line('-'.repeat(width))
    .line(formatLocal(notice.createdAt, notice.timeZone))
    .finish();
}
