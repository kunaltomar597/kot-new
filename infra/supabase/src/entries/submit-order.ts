// Supabase entry of the `submit-order` function (bundled by scripts/bundle-functions.mjs).
import { serve } from '../deno/serve.js';
import { submitOrder } from '../submit-order.js';

serve(submitOrder);
