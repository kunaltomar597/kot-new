import { fontSize, fontWeight, spacing } from '@rp/design-tokens';
import { useTheme, weight } from '@rp/ui-native';
import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSessionState, useT } from './context.js';

/** Says so when the server cannot be reached; nothing while connected (NFR-A01). */
export function ConnectionBanner() {
  const { connection } = useSessionState();
  const t = useT();
  const { colors } = useTheme();
  if (connection === 'online' || connection === 'stopped') return null;
  const offline = connection === 'offline';
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      testID="connection-banner"
      style={[
        styles.banner,
        { backgroundColor: offline ? colors.warningSubtle : colors.infoSubtle },
      ]}
    >
      <Text style={{ color: offline ? colors.warningText : colors.infoText }}>
        {t(offline ? 'connection.offline' : 'connection.connecting')}
      </Text>
    </View>
  );
}

/** A full screen with the connection banner, a title and scrolling content. */
export function Screen({
  title,
  actions,
  children,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ConnectionBanner />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {title !== undefined && (
          <View style={styles.header}>
            <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
              {title}
            </Text>
            {actions}
          </View>
        )}
        {children}
      </ScrollView>
    </View>
  );
}

/** A line of plain text in the theme's colours; `tone` for errors and hints. */
export function Note({
  children,
  tone = 'muted',
  testID,
}: {
  children: string;
  tone?: 'muted' | 'danger' | 'text';
  testID?: string;
}) {
  const { colors } = useTheme();
  const color =
    tone === 'danger' ? colors.dangerText : tone === 'text' ? colors.text : colors.textMuted;
  return (
    <Text
      testID={testID}
      accessibilityRole={tone === 'danger' ? 'alert' : 'text'}
      style={[styles.note, { color }]}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  banner: { paddingHorizontal: spacing[4], paddingVertical: spacing[2] },
  content: { padding: spacing[4], gap: spacing[3] },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[2],
  },
  title: { fontSize: fontSize.xl, fontWeight: weight(fontWeight.bold) },
  note: { fontSize: fontSize.md },
});
