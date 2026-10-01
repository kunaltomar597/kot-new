// Supabase entry of the `service-request` function (bundled by scripts/bundle-functions.mjs).
import { serve } from '../deno/serve.js';
import { serviceRequest } from '../service-request.js';

serve(serviceRequest);
