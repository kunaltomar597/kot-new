import { Button, Dialog } from '@rp/ui-web';
import { useEffect, useMemo, useState } from 'react';
import { useConsole, useConsoleState } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { type LocateSound, webAudioSounds } from '../kds/sounds.js';

/** How long the device shows itself unless someone taps OK. */
export const LOCATE_SHOW_MS = 15_000;
/** The chime repeats this often while shown, so the device can be followed by ear. */
export const LOCATE_REPEAT_MS = 3_000;
/** Loud: the point is to be found across the room. */
const LOCATE_VOLUME_PERCENT = 100;

/**
 * Shows this device's name and chimes when a manager looks for it from the Devices page
 * (MGR-006 "Locate", P4-02c), on any screen, signed in or not. Only this device hears the request,
 * and only while connected. Browsers play sound only after someone touched the page, so the
 * first touch or key press unlocks it; before that the device still shows its name.
 */
export function LocateOverlay({ sounds: given }: { sounds?: LocateSound }) {
  const t = useT();
  const controller = useConsole();
  const { device } = useConsoleState();
  const sounds = useMemo(() => given ?? webAudioSounds(), [given]);
  const [shown, setShown] = useState<{ readonly name: string; readonly at: string }>();
  const deviceId = device?.id;

  useEffect(() => {
    const unlock = () => {
      sounds.unlock();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [sounds]);

  useEffect(() => {
    if (deviceId === undefined) return;
    return controller.onEvent((event) => {
      if (event.type === 'DeviceLocateRequested' && event.payload.deviceId === deviceId) {
        setShown({ name: event.payload.name, at: event.occurredAt });
      }
    });
  }, [controller, deviceId]);

  // A repeated request starts the chime and the time shown again.
  useEffect(() => {
    if (shown === undefined) return;
    sounds.locate(LOCATE_VOLUME_PERCENT);
    const repeat = setInterval(() => {
      sounds.locate(LOCATE_VOLUME_PERCENT);
    }, LOCATE_REPEAT_MS);
    const hide = setTimeout(() => {
      setShown(undefined);
    }, LOCATE_SHOW_MS);
    return () => {
      clearInterval(repeat);
      clearTimeout(hide);
    };
  }, [shown, sounds]);

  if (shown === undefined || deviceId === undefined) return null;
  const dismiss = () => {
    setShown(undefined);
  };
  return (
    <Dialog
      open
      size="sm"
      onClose={dismiss}
      className="locate-dialog"
      title={t('locate.title', { name: shown.name })}
      description={t('locate.description')}
      footer={
        <Button data-autofocus onClick={dismiss}>
          {t('locate.dismiss')}
        </Button>
      }
    />
  );
}
