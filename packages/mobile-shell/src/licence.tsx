import { spacing } from '@rp/design-tokens';
import { affectsLicence, licenceNotice } from '@rp/ordering';
import { useTheme } from '@rp/ui-native';
import { StyleSheet, Text, View } from 'react-native';
import { useDeviceSession, useSessionState, useT } from './context.js';
import { useLive } from './use-live.js';

function Banner() {
  const session = useDeviceSession();
  const t = useT();
  const { colors } = useTheme();
  const { data } = useLive(() => session.api.getLicence(), affectsLicence);
  if (data.status !== 'ready') return null;
  // The payment reminder is for the POS and the dashboard (LIC-005); phones show the rest.
  const notice = licenceNotice(data.value, t, { paymentReminder: false });
  if (notice === undefined) return null;
  const danger = notice.tone === 'danger';
  return (
    <View
      accessibilityRole={danger ? 'alert' : 'text'}
      testID="licence-banner"
      style={[
        styles.banner,
        { backgroundColor: danger ? colors.dangerSubtle : colors.warningSubtle },
      ]}
    >
      <Text style={{ color: danger ? colors.dangerText : colors.warningText }}>
        {notice.message}
      </Text>
    </View>
  );
}

/**
 * The licence's banner on staff screens (LIC-005): the days left in grace or before a restriction,
 * and the restricted notice. Only for a signed-in person, never on a table tablet.
 */
export function LicenceBanner() {
  const { person, device } = useSessionState();
  if (person === undefined || device?.type === 'TABLE_TABLET') return null;
  return <Banner />;
}

const styles = StyleSheet.create({
  banner: { paddingHorizontal: spacing[4], paddingVertical: spacing[2] },
});
