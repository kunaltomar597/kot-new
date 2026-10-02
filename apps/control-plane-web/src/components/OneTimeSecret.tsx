import { Button } from '@rp/ui-web';
import { useState } from 'react';
import { useT } from '../app/i18n.js';

/**
 * A code or link shown once (activation codes, reactivation codes, setup links): it is not kept
 * anywhere it can be read again, so the person copies it now.
 */
export function OneTimeSecret({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="cp-secret">
      <p className="cp-secret__label">{label}</p>
      <output className="cp-secret__value" aria-label={label}>
        {value}
      </output>
      {hint === undefined ? null : <p className="cp-hint">{hint}</p>}
      <p className="cp-hint">{t('vendorApp.secret.once')}</p>
      <Button
        variant="secondary"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(
            () => {
              setCopied(true);
            },
            () => {
              setCopied(false);
            },
          );
        }}
      >
        {copied ? t('vendorApp.secret.copied') : t('vendorApp.secret.copy')}
      </Button>
    </div>
  );
}
