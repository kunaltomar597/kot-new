// Supabase entry of the `order-status` function (bundled by scripts/bundle-functions.mjs).
import { serve } from '../deno/serve.js';
import { orderStatus } from '../order-status.js';

serve(orderStatus);
