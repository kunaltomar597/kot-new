// Writes dist/tokens.css from the compiled tokens so the CSS can never drift from the TS objects.
import { writeFileSync } from 'node:fs';
import { buildTokensCss } from '../dist/index.js';

writeFileSync(new URL('../dist/tokens.css', import.meta.url), buildTokensCss());
