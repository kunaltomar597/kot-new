import { PairingCode } from '@rp/contracts';
import { Button, Card, TextField } from '@rp/ui-web';
import { type SyntheticEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { useConsole, useConsoleState } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { canCreateDeviceKey, formatPairingCode, messageOf } from '../app/messages.js';

/**
 * Pairs this browser with a manager's one-time code (AUTH-007). The browser creates a device key
 * that never leaves it; the code proves a manager allowed it.
 */
export function PairingScreen() {
  const t = useT();
  const controller = useConsole();
  const { notice } = useConsoleState();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const secure = canCreateDeviceKey();
  const valid = PairingCode.safeParse(code).success;

  async function submit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await controller.pair(code);
      await navigate('/', { replace: true });
    } catch (caught) {
      setError(messageOf(caught, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="console-center">
      <Card title={t('pairing.title')} headingLevel={2} variant="raised" className="console-panel">
        {notice === 'revoked' ? (
          <p className="console-notice" role="status">
            {t('pairing.revoked')}
          </p>
        ) : null}
        {secure ? null : (
          <p className="console-notice console-notice--danger" role="alert">
            {t('pairing.insecureContext')}
          </p>
        )}
        <form
          className="console-form"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <TextField
            label={t('pairing.codeLabel')}
            hint={t('pairing.intro')}
            value={code}
            onChange={(event) => {
              setCode(formatPairingCode(event.target.value));
            }}
            error={error}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            disabled={!secure}
            required
          />
          <Button type="submit" size="lg" disabled={!secure || !valid || busy}>
            {busy ? t('pairing.working') : t('pairing.submit')}
          </Button>
        </form>
      </Card>
    </main>
  );
}
