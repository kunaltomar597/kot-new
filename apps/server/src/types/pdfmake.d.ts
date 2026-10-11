/**
 * The part of pdfmake 0.3 the server uses (P4-06). Declared here instead of `@types/pdfmake`,
 * which pulls the browser's DOM types into the server build.
 */
declare module 'pdfmake' {
  type Margins = [number, number, number, number];

  export interface TableCell {
    readonly text: string;
    readonly style?: string;
    readonly alignment?: 'left' | 'right' | 'center';
    readonly bold?: boolean;
  }

  export type Content =
    | {
        readonly text: string;
        readonly style?: string;
        readonly color?: string;
        readonly fontSize?: number;
        readonly bold?: boolean;
        readonly alignment?: 'left' | 'right' | 'center';
        readonly margin?: Margins;
      }
    | {
        /** A QR code of `qr`, at most `fit` points wide (P5-04). */
        readonly qr: string;
        readonly fit: number;
        readonly eccLevel?: 'L' | 'M' | 'Q' | 'H';
        readonly alignment?: 'left' | 'right' | 'center';
        readonly margin?: Margins;
      }
    | {
        readonly stack: readonly Content[];
        readonly margin?: Margins;
        readonly pageBreak?: 'before';
      }
    | {
        readonly columns: readonly (Content & { readonly width?: '*' | number })[];
        readonly columnGap?: number;
        readonly pageBreak?: 'before';
      }
    | {
        readonly table: {
          readonly headerRows: number;
          readonly widths: readonly ('*' | 'auto' | number)[];
          readonly body: readonly (readonly TableCell[])[];
        };
        readonly layout?: string;
      };

  export interface Style {
    readonly fontSize?: number;
    readonly bold?: boolean;
    readonly italics?: boolean;
    readonly color?: string;
    readonly alignment?: 'left' | 'right' | 'center';
    readonly margin?: Margins;
  }

  export interface CanvasLine {
    readonly type: 'line';
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
    readonly lineWidth?: number;
    readonly lineColor?: string;
    readonly dash?: { readonly length: number };
  }

  export interface DocumentDefinition {
    readonly pageSize: 'A4' | 'A5' | 'A6';
    /** Drawn under each page's content, e.g. a fold line. */
    readonly background?: (
      page: number,
      size: { readonly width: number; readonly height: number },
    ) => { readonly canvas: readonly CanvasLine[] } | null;
    readonly pageOrientation: 'portrait' | 'landscape';
    readonly pageMargins: Margins;
    readonly info?: Readonly<Record<string, string>>;
    readonly content: readonly Content[];
    readonly footer?: (page: number, pages: number) => { text: string; style?: string };
    readonly defaultStyle?: Style & { readonly font?: string };
    readonly styles?: Readonly<Record<string, Style>>;
  }

  export interface FontFiles {
    readonly normal: string;
    readonly bold: string;
    readonly italics: string;
    readonly bolditalics: string;
  }

  interface PdfMake {
    setFonts(fonts: Readonly<Record<string, FontFiles>>): void;
    setUrlAccessPolicy(check: (url: string) => boolean): void;
    setLocalAccessPolicy(check: (path: string) => boolean): void;
    createPdf(definition: DocumentDefinition): { getBuffer(): Promise<Buffer> };
  }

  const pdfmake: PdfMake;
  export default pdfmake;
}
