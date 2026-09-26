import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const SERVER_DIST = join(here, '..', '..', 'server', 'dist');
export const CONSOLE_DIST = join(here, '..', 'dist');
