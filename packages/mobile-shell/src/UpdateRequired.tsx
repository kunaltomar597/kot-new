import { ApkOffer, apkOffered } from './ApkOffer.js';
import { Note, Screen } from './Screen.js';
import { useApkUpdate, useAppUpdate, useSessionState, useT } from './context.js';

/** An over-the-air update the server serves is on its way, and the app restarts on it by itself. */
const ON_ITS_WAY = new Set(['downloading', 'ready', 'applying']);

/**
 * The server no longer serves this build of the app (UPD-006, 426 `CLIENT_TOO_OLD`): one screen
 * saying so, instead of every screen failing. On a table tablet it speaks to the guests (a kiosk
 * tablet installs the PC's new version by itself). When an over-the-air update the server serves
 * is coming (P7-04e1), staff are told it fixes itself; when the PC has a new APK of the app
 * (P7-04e2), they install it here.
 */
export function UpdateRequiredScreen() {
  const { device } = useSessionState();
  const update = useAppUpdate();
  const apk = useApkUpdate();
  const t = useT();
  const guests = device?.type === 'TABLE_TABLET';
  const coming = update !== undefined && ON_ITS_WAY.has(update.status);
  return (
    <Screen title={t(guests ? 'mobile.update.guestsTitle' : 'mobile.update.title')}>
      <Note tone="text" testID="update-required">
        {t(
          guests
            ? 'mobile.update.guests'
            : coming
              ? 'mobile.update.onItsWay'
              : apkOffered(apk)
                ? 'mobile.update.fromPc'
                : 'mobile.update.staff',
        )}
      </Note>
      {guests ? null : <ApkOffer />}
    </Screen>
  );
}
