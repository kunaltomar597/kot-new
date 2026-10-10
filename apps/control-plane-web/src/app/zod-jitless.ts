import { config } from 'zod';

/**
 * Zod compiles faster parsers with `new Function` unless told not to. This page's CSP allows no
 * eval and its Trusted Types refuse it (P8-03c1), so Zod would only probe, fail and fall back,
 * reporting a violation on every page load. main.tsx imports this first, before any schema is
 * built (Zod reads the setting as it builds them).
 */
config({ jitless: true });
