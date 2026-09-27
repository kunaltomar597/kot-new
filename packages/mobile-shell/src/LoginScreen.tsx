import type { StaffTile } from '@rp/contracts';
import { spacing } from '@rp/design-tokens';
import { Button, PinPad } from '@rp/ui-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useDeviceSession, useSessionState, useT } from './context.js';
import { messageOf } from './messages.js';
import { Note, Screen } from './Screen.js';
import { useLive } from './use-live.js';

const NEVER = () => false;

/** Staff tap their name and enter their PIN (AUTH-001, AUTH-002, AUTH-004). */
export function LoginScreen({ roles }: { roles?: readonly StaffTile['role'][] }) {
  const session = useDeviceSession();
  const { notice } = useSessionState();
  const t = useT();
  const { data, reload } = useLive(() => session.staffTiles(), NEVER);
  const [person, setPerson] = useState<StaffTile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signIn = (pin: string) => {
    if (person === null) return;
    setBusy(true);
    setError(null);
    session.signIn(person.staffId, pin).then(
      () => {
        setBusy(false);
      },
      (failure: unknown) => {
        setBusy(false);
        setError(messageOf(failure, t));
      },
    );
  };

  if (person !== null) {
    return (
      <Screen title={t('login.pinFor', { name: person.displayName })}>
        <PinPad
          label={t('login.pinFor', { name: person.displayName })}
          onComplete={signIn}
          error={error}
          busy={busy}
        />
        <Button
          variant="secondary"
          onPress={() => {
            setPerson(null);
            setError(null);
          }}
        >
          {t('login.notYou')}
        </Button>
      </Screen>
    );
  }

  const noticeText =
    notice === 'signedOutInactive'
      ? t('login.signedOutInactive')
      : notice === 'signedOut'
        ? t('login.signedOut')
        : null;

  return (
    <Screen title={t('mobile.staffTitle')}>
      {noticeText !== null && <Note tone="danger">{noticeText}</Note>}
      {data.status === 'loading' && <Note>{t('states.loading')}</Note>}
      {data.status === 'error' && (
        <>
          <Note tone="danger">{messageOf(data.error, t)}</Note>
          <Button variant="secondary" onPress={reload}>
            {t('states.retry')}
          </Button>
        </>
      )}
      {data.status === 'ready' && (
        <View style={styles.tiles}>
          {(() => {
            const staff = data.value.filter(
              (tile) => roles === undefined || roles.includes(tile.role),
            );
            if (staff.length === 0) return <Note>{t('login.noStaff')}</Note>;
            return staff.map((tile) => (
              <Button
                key={tile.staffId}
                testID={`staff-${tile.staffId}`}
                variant="secondary"
                size="lg"
                fullWidth
                accessibilityLabel={`${tile.displayName}, ${t(`roles.${tile.role}`)}`}
                onPress={() => {
                  session.dismissNotice();
                  setPerson(tile);
                }}
              >
                {tile.displayName}
              </Button>
            ));
          })()}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  tiles: { gap: spacing[2] },
});
