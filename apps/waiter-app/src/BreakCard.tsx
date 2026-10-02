import { spacing } from '@rp/design-tokens';
import { displayDateTime } from '@rp/domain';
import { messageOf, Note, useDeviceSession, useLive, useT } from '@rp/mobile-shell';
import { Button, toneColors, useTheme } from '@rp/ui-native';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

/**
 * "On break" (NTF-009): while the waiter is on break, their alerts go to the manager on duty; the
 * card says so and brings them back with one tap.
 */
export function BreakCard() {
  const session = useDeviceSession();
  const t = useT();
  const { colors } = useTheme();
  const { data, reload } = useLive(
    () => session.api.getMyBreak(),
    () => false,
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();

  if (data.status !== 'ready') return null;
  const { onBreak, since } = data.value;
  const set = async (next: boolean) => {
    setBusy(true);
    setFailure(undefined);
    try {
      await session.api.setMyBreak({ body: { onBreak: next } });
      reload();
    } catch (error) {
      setFailure(messageOf(error, t));
    } finally {
      setBusy(false);
    }
  };
  const tone = toneColors(colors, 'warning');
  return (
    <View
      testID="break-card"
      style={[
        styles.card,
        onBreak ? { backgroundColor: tone.subtle, borderColor: tone.solid } : undefined,
      ]}
      accessibilityRole={onBreak ? 'alert' : 'summary'}
    >
      {onBreak && since !== null ? (
        <Text style={{ color: tone.text }}>
          {t('mobile.break.onBreak', { time: displayDateTime(new Date(since)).time })}
        </Text>
      ) : (
        <Note>{t('mobile.break.hint')}</Note>
      )}
      <Button
        variant={onBreak ? 'primary' : 'secondary'}
        disabled={busy}
        onPress={() => void set(!onBreak)}
      >
        {onBreak ? t('mobile.break.end') : t('mobile.break.start')}
      </Button>
      {failure === undefined ? null : <Note>{failure}</Note>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing[2],
    padding: spacing[3],
    borderWidth: 1,
    borderRadius: 8,
    borderColor: 'transparent',
  },
});
