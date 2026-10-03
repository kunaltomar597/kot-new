import { Button } from '@rp/ui-web';
import { Link } from 'react-router';
import { useT } from '../../app/i18n.js';

/** The checklist's items, in the order an installer walks the restaurant (ONB-011, BRD §11). */
export const READINESS_ITEMS = [
  'pc',
  'backupDrive',
  'bitlocker',
  'ups',
  'wifiSeparate',
  'coverage',
  'printers',
  'tablets',
  'speechPack',
  'phones',
  'internet',
] as const;

/**
 * The printable site-readiness checklist (ONB-011): what the restaurant should have in place
 * before the installer comes, from the BRD's hardware and site requirements (§11). Printed and
 * ticked by hand on site.
 */
export function ReadinessChecklist() {
  const t = useT();
  return (
    <section className="dashboard-section readiness" aria-labelledby="readiness-title">
      <div className="readiness__actions">
        <Link className="console-link" to="/manage/setup">
          {t('readiness.back')}
        </Link>
        <Button
          variant="secondary"
          onClick={() => {
            globalThis.print();
          }}
        >
          {t('readiness.print')}
        </Button>
      </div>
      <h2 id="readiness-title" className="dashboard-section__heading">
        {t('readiness.title')}
      </h2>
      <p className="dashboard-section__hint">{t('readiness.intro')}</p>
      <table className="readiness-table">
        <caption className="rp-visually-hidden">{t('readiness.title')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('readiness.done')}</th>
            <th scope="col">{t('readiness.item')}</th>
            <th scope="col">{t('readiness.notes')}</th>
          </tr>
        </thead>
        <tbody>
          {READINESS_ITEMS.map((item) => (
            <tr key={item}>
              <td>
                <span className="readiness-box" aria-hidden="true" />
              </td>
              <td>
                <strong>{t(`readiness.items.${item}.title`)}</strong>
                <br />
                {t(`readiness.items.${item}.detail`)}
              </td>
              <td className="readiness-notes" />
            </tr>
          ))}
        </tbody>
      </table>
      <p className="readiness-sign">{t('readiness.signature')}</p>
    </section>
  );
}
