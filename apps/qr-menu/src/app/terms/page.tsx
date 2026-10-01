import { t } from '../../site/server-i18n';

/** QR-013 (drafts for the restaurant's and the vendor's legal review). */
export default function Page() {
  return (
    <main className="qr-page qr-legal">
      <h1>{t('qrSite.terms.title')}</h1>
      <p>{t('qrSite.terms.body1')}</p>
      <p>{t('qrSite.terms.body2')}</p>
      <p>{t('qrSite.terms.body3')}</p>
    </main>
  );
}
