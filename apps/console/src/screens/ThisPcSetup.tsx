import { Pin } from '@rp/contracts';
import { Button, Card, TextField } from '@rp/ui-web';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useConsole } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';

/** The console is open on the restaurant PC itself (where the server runs). */
export function onServerPc(hostname: string = globalThis.location.hostname): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

/**
 * On the restaurant PC itself (ONB-001, P7-07b): on a fresh install, create the restaurant and
 * its Owner; then pair this PC as the first POS with the bootstrap code, so the Owner can sign in
 * and carry on with the set-up page. Elsewhere the console pairs with a manager's code as usual.
 */
export function ThisPcSetup() {
  const t = useT();
  const controller = useConsole();
  const navigate = useNavigate();
  const [needed, setNeeded] = useState<boolean | undefined>();
  const [pinLength, setPinLength] = useState(4);
  const [restaurantName, setRestaurantName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [pin, setPin] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    controller.api.getFirstRun().then(
      (status) => {
        setNeeded(status.needed);
        setPinLength(status.pinLength);
      },
      () => {
        setNeeded(false);
      },
    );
  }, [controller]);

  const pairThisPc = async () => {
    const { code } = await controller.api.createBootstrapPairingCode();
    await controller.pair(code);
    await navigate('/', { replace: true });
  };

  const run = (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    work().then(
      () => {
        setBusy(false);
      },
      (failure: unknown) => {
        setBusy(false);
        setError(messageOf(failure, t));
      },
    );
  };

  if (needed === undefined) return null;
  const pinValid = Pin.safeParse(pin).success && pin.length === pinLength;
  const mismatch = repeat.length > 0 && repeat !== pin;

  return (
    <Card title={t('firstRun.title')} headingLevel={2} variant="raised" className="console-panel">
      {needed ? (
        <form
          className="console-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!pinValid || repeat !== pin) return;
            run(async () => {
              await controller.api.completeFirstRun({
                body: { restaurantName, ownerName, ownerPin: pin },
              });
              await pairThisPc();
            });
          }}
        >
          <p className="dashboard-section__hint">{t('firstRun.intro')}</p>
          <TextField
            label={t('firstRun.restaurantName')}
            hint={t('firstRun.restaurantNameHint')}
            value={restaurantName}
            maxLength={60}
            onChange={(event) => {
              setRestaurantName(event.target.value);
            }}
          />
          <TextField
            label={t('firstRun.ownerName')}
            value={ownerName}
            maxLength={80}
            onChange={(event) => {
              setOwnerName(event.target.value);
            }}
          />
          <TextField
            label={t('firstRun.pin')}
            hint={t('firstRun.pinHint', { digits: pinLength })}
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            value={pin}
            maxLength={pinLength}
            onChange={(event) => {
              setPin(event.target.value.replace(/\D/g, ''));
            }}
          />
          <TextField
            label={t('firstRun.repeatPin')}
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            value={repeat}
            maxLength={pinLength}
            error={mismatch ? t('firstRun.pinMismatch') : undefined}
            onChange={(event) => {
              setRepeat(event.target.value.replace(/\D/g, ''));
            }}
          />
          <Button
            type="submit"
            size="lg"
            loading={busy}
            disabled={
              busy ||
              restaurantName.trim() === '' ||
              ownerName.trim() === '' ||
              !pinValid ||
              repeat !== pin
            }
          >
            {t('firstRun.create')}
          </Button>
        </form>
      ) : (
        <div className="console-form">
          <p className="dashboard-section__hint">{t('firstRun.pairIntro')}</p>
          <Button
            variant="secondary"
            loading={busy}
            onClick={() => {
              run(pairThisPc);
            }}
          >
            {t('firstRun.pair')}
          </Button>
        </div>
      )}
      {error === undefined ? null : (
        <p role="alert" className="console-notice console-notice--danger">
          {error}
        </p>
      )}
    </Card>
  );
}
