import { fontSize, fontWeight, radius, spacing } from '@rp/design-tokens';
import { pagerWarning } from '@rp/domain';
import { Note, useDeviceSession, useLive, useT } from '@rp/mobile-shell';
import { Glyph, toneColors, useTheme, weight } from '@rp/ui-native';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';

/** Battery levels are not announced (only a change to low or offline is), so read them again. */
export const PAGER_REFRESH_MS = 60_000;

/** Its state changed, or it was given to someone or taken back (`RestaurantChanged`, P4-02b). */
const affectsPager = (eventType: string) =>
  eventType === 'DeviceStatusChanged' || eventType === 'RestaurantChanged';

/**
 * The waiter's own pager (WTR-014): its connection and battery, with a warning when it is not
 * connected or its battery is at or below the restaurant's low level (PGR-013 ⚙).
 */
export function PagerCard() {
  const session = useDeviceSession();
  const t = useT();
  const { colors } = useTheme();
  const { data, reload } = useLive(() => session.api.getMyPager(), affectsPager);
  useEffect(() => {
    const timer = setInterval(reload, PAGER_REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [reload]);

  if (data.status === 'loading') return null;
  if (data.status === 'error') return <Note>{t('mobile.pager.unavailable')}</Note>;
  const { pager, lowBatteryPercent } = data.value;
  if (pager === null) return <Note>{t('mobile.pager.none')}</Note>;

  const warning = pagerWarning(pager, lowBatteryPercent);
  const tone = toneColors(colors, warning === undefined ? 'success' : 'warning');
  const facts = [
    t(pager.online ? 'mobile.pager.connected' : 'mobile.pager.notConnected'),
    pager.batteryPercent === null
      ? t('mobile.pager.batteryUnknown')
      : t('mobile.pager.battery', { percent: pager.batteryPercent }),
  ];
  const message =
    warning === undefined
      ? undefined
      : t(warning === 'OFFLINE' ? 'mobile.pager.offlineWarning' : 'mobile.pager.lowWarning');
  const heading = `${t('mobile.pager.title')}: ${pager.name}`;
  return (
    <View
      accessible
      accessibilityRole={message === undefined ? 'summary' : 'alert'}
      accessibilityLabel={[heading, ...facts, ...(message === undefined ? [] : [message])].join(
        ', ',
      )}
      testID="pager-card"
      style={[styles.card, { backgroundColor: tone.subtle, borderColor: tone.solid }]}
    >
      <View style={styles.row}>
        <Glyph name={message === undefined ? 'check' : 'warning'} color={tone.text} />
        <Text style={[styles.heading, { color: colors.text }]}>{heading}</Text>
      </View>
      <Text style={{ color: colors.text }}>{facts.join(' · ')}</Text>
      {message === undefined ? null : <Text style={{ color: tone.text }}>{message}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.md, padding: spacing[3], gap: spacing[1] },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  heading: { fontSize: fontSize.md, fontWeight: weight(fontWeight.semibold) },
});
