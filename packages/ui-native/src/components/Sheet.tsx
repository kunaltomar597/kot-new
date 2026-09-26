import { elevation, fontSize, fontWeight, radius, spacing, touchTarget } from '@rp/design-tokens';
import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useUiStrings } from '../strings.js';
import { useTheme, weight } from '../theme.js';
import { Glyph } from './Glyph.js';

export interface SheetProps {
  open: boolean;
  /** Called by the close button, the Android back button and a tap on the scrim. */
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Actions pinned under the scrolling content, e.g. the quantity and "Add ₹240.00". */
  footer?: ReactNode;
  /** When false, the scrim and back button do nothing (e.g. while a submission is in flight). */
  dismissible?: boolean;
}

/**
 * A bottom sheet over the current screen: the waiter app's item options, table actions and
 * confirmations. The native counterpart of `@rp/ui-web` Dialog, with the same close words.
 */
export function Sheet({ open, onClose, title, children, footer, dismissible = true }: SheetProps) {
  const { colors } = useTheme();
  const strings = useUiStrings().dialog;
  const close = () => {
    if (dismissible) onClose();
  };
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={close}>
      <View style={styles.backdrop}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={strings.close}
          importantForAccessibility="no"
          testID="sheet-scrim"
          onPress={close}
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }]}
        />
        <View
          accessibilityViewIsModal
          style={[styles.sheet, { backgroundColor: colors.surfaceRaised }]}
        >
          <View style={styles.header}>
            <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
              {title}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={strings.close}
              accessibilityState={{ disabled: !dismissible }}
              disabled={!dismissible}
              onPress={onClose}
              testID="sheet-close"
              style={styles.close}
            >
              <Glyph name="close" color={colors.textMuted} size={fontSize.xl} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.body}>{children}</ScrollView>
          {footer === undefined ? null : (
            <View style={[styles.footer, { borderTopColor: colors.border }]}>{footer}</View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '90%',
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    elevation: elevation[3].androidElevation,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: spacing[4],
    paddingTop: spacing[2],
  },
  title: { flex: 1, fontSize: fontSize.xl, fontWeight: weight(fontWeight.bold) },
  close: {
    width: touchTarget.min,
    height: touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { padding: spacing[4], gap: spacing[4] },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[4],
    borderTopWidth: 1,
  },
});
