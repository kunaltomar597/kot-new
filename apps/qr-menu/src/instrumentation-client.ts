import { config } from 'zod';

/**
 * Runs in the browser before the site's own code (Next.js's client instrumentation). Zod compiles
 * faster parsers with `new Function` unless told not to; the site's CSP allows no eval
 * (P8-03c1), so Zod would only probe, fail and fall back, reporting a violation on every page.
 * Zod reads the setting as it builds its schemas, so it is set before any is built.
 */
config({ jitless: true });
