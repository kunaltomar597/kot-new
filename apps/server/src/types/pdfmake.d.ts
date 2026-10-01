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
    | { readonly text: string; readonly style?: string }
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

  export interface DocumentDefinition {
    readonly pageSize: 'A4';
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
