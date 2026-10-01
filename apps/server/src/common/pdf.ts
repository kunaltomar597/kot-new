import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import pdfmake from 'pdfmake';

/**
 * pdfmake as the server uses it (report exports P4-06, table tents P5-04): Roboto as shipped with
 * pdfmake (it has the ₹ sign), and nothing loaded from the network or the disk beyond the fonts.
 */
const require = createRequire(import.meta.url);
const FONTS = require('pdfmake/fonts/Roboto') as {
  Roboto: { normal: string; bold: string; italics: string; bolditalics: string };
};
const FONT_DIR = dirname(FONTS.Roboto.normal);
pdfmake.setFonts(FONTS);
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((path) => path.startsWith(FONT_DIR));

export { pdfmake };
