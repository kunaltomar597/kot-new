import { Button, Dialog, TextField } from '@rp/ui-web';
import { useState, useSyncExternalStore } from 'react';
import { useT } from '../app/i18n.js';
import { useStepUp } from '../app/services.js';

/** Asks for a new authenticator code when the API client needs one (CP-S2). */
export function StepUpDialog() {
  const t = useT();
  const prompt = useStepUp();
  const open = useSyncExternalStore(prompt.subscribe, prompt.isOpen);
  const [code, setCode] = useState('');
  const done = (answer: string | undefined) => {
    setCode('');
    prompt.answer(answer);
  };
  return (
    <Dialog
      open={open}
      onClose={() => {
        done(undefined);
      }}
      title={t('vendorApp.stepUp.title')}
      description={t('vendorApp.stepUp.intro')}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              done(undefined);
            }}
          >
            {t('vendorApp.actions.cancel')}
          </Button>
          <Button
            disabled={!/^\d{6}$/.test(code)}
            onClick={() => {
              done(code);
            }}
          >
            {t('vendorApp.stepUp.confirm')}
          </Button>
        </>
      }
    >
      <TextField
        label={t('vendorApp.stepUp.code')}
        hint={t('vendorApp.stepUp.codeHint')}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        onChange={(event) => {
          setCode(event.target.value.replace(/\D/g, ''));
        }}
      />
    </Dialog>
  );
}
