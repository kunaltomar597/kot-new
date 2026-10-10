import type { NextConfig } from 'next';

/**
 * The QR menu site (P5-05). RELAY_URL (the relay's functions, e.g.
 * https://<project>.supabase.co/functions/v1) is read at request time, so one build serves any
 * deployment; the Content-Security-Policy that names it is set in src/proxy.ts.
 *
 * Privacy (QR-013): no third-party scripts, styles, fonts or trackers, and no referrer sent
 * anywhere, since the address holds the table's code.
 */
const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          // SEC-001: the site is only ever on https; browsers ignore this on plain http (tests).
          { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
        ],
      },
    ]);
  },
};

export default config;
