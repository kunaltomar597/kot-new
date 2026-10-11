import { Footer } from '../site/Footer';
import { t } from '../site/server-i18n';

export default function Landing() {
  return (
    <main className="qr-page qr-message">
      <h1>{t('qrSite.landing.title')}</h1>
      <p>{t('qrSite.landing.body')}</p>
      <Footer />
    </main>
  );
}
