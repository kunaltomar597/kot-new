// Supabase entry of the `server` function (bundled by scripts/bundle-functions.mjs).
import { serve } from '../deno/serve.js';
import { server } from '../server.js';

serve(server);
