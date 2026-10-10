import '@rp/design-tokens/tokens.css';
import '@rp/ui-web/styles.css';
import './qr.css';
import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Menu',
  description: 'The menu of the restaurant you are at. Order from your table.',
  // A table's page is for the people at that table, not for search engines.
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#ffffff',
};

/**
 * Every page is rendered for its request (P8-03c1): Next.js puts the request's CSP nonce on its
 * scripts only while rendering, so a page built ahead of time would have scripts the policy
 * refuses (src/proxy.ts).
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
