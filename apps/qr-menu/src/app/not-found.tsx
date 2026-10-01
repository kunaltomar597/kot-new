import { Footer } from '../site/Footer';
import { t } from '../site/server-i18n';

export default function NotFound() {
  return (
    <main className="qr-page qr-message">
      <h1>{t('qrSite.notFound.title')}</h1>
      <p>{t('qrSite.notFound.body')}</p>
      <Footer />
    </main>
  );
}
