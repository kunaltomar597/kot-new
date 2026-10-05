import { Note, Screen } from './Screen.js';
import { useSessionState, useT } from './context.js';

/**
 * The server no longer serves this build of the app (UPD-006, 426 `CLIENT_TOO_OLD`): one screen
 * saying so, instead of every screen failing. On a table tablet it speaks to the guests.
 */
export function UpdateRequiredScreen() {
  const { device } = useSessionState();
  const t = useT();
  const guests = device?.type === 'TABLE_TABLET';
  return (
    <Screen title={t(guests ? 'mobile.update.guestsTitle' : 'mobile.update.title')}>
      <Note tone="text" testID="update-required">
        {t(guests ? 'mobile.update.guests' : 'mobile.update.staff')}
      </Note>
    </Screen>
  );
}
