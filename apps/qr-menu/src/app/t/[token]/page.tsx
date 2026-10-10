import { TableToken } from '@rp/contracts/relay';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Footer } from '../../../site/Footer';
import { QrMenu } from '../../../site/QrMenu';
import { sharedMenu } from '../../../site/menu-cache';
import { RelayCallError } from '../../../site/relay';
import { t } from '../../../site/server-i18n';

// Live availability and the restaurant's presence: rendered for each visit, never cached.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Menu' };

function relayUrl(): string {
  const url = process.env.RELAY_URL;
  if (url === undefined || url === '') throw new Error('RELAY_URL is not set');
  return url.replace(/\/+$/, '');
}

/**
 * A table's QR menu (QR-002): the menu comes from the relay on the server, so the first view is
 * already the menu (QR-012, LCP); the page then talks to the relay from the browser.
 */
export default async function TablePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!TableToken.safeParse(token).success) notFound();
  const relay = relayUrl();
  let menu;
  try {
    menu = await sharedMenu(relay, token);
  } catch (error) {
    if (error instanceof RelayCallError && error.status === 404) notFound();
    if (error instanceof RelayCallError && error.code === 'MENU_NOT_PUBLISHED') {
      return (
        <main className="qr-page qr-message">
          <h1>{t('qrSite.notReady.title')}</h1>
          <p>{t('qrSite.notReady.body')}</p>
          <Footer />
        </main>
      );
    }
    throw error;
  }
  if (menu.document === null) throw new Error('The relay sent no menu');
  return (
    <>
      <QrMenu token={token} relayUrl={relay} initial={{ ...menu, document: menu.document }} />
      <Footer />
    </>
  );
}
