// Copies the component stylesheets next to the compiled JS (tsc does not copy CSS).
import { cpSync } from 'node:fs';

cpSync(new URL('../src/styles', import.meta.url), new URL('../dist/styles', import.meta.url), {
  recursive: true,
});
