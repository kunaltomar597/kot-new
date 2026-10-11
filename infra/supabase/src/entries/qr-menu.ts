// Supabase entry of the `qr-menu` function (bundled by scripts/bundle-functions.mjs).
import { serve } from '../deno/serve.js';
import { qrMenu } from '../qr-menu.js';

serve(qrMenu);
