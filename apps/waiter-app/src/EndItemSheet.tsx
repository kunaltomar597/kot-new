import type { OrderView } from '@rp/contracts';
import { spacing } from '@rp/design-tokens';
import { Note, useT } from '@rp/mobile-shell';
import { Button, Sheet, TextField } from '@rp/ui-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

/** As long as the server keeps (`OrderItemEndRequest`). */
const REASON_MAX = 200;
const REASON_MIN = 3;

/** Reasons offered in one tap for each ending; the waiter can still write their own. */
const QUICK = {
  CANCEL: ['changedMind', 'mistake', 'slow'],
  VOID: ['sentBack', 'quality', 'wrongDish', 'spilled'],
} as const;

export type Ending = 'CANCEL' | 'VOID';

/**
 * Why a sent item is taken back (ORD-011, WTR-009): a cancel while the kitchen has not started it,
 * or a void after, which needs a manager's PIN for waiters. Every ending needs a reason for the
 * audit log (AUD-001); a common one is a tap away.
 */
export function EndItemSheet({
  line,
  ending,
  managerNeeded,
  onClose,
  onConfirm,
}: {
  line: OrderView['items'][number];
  ending: Ending;
  /** The person needs a manager's approval to void (BRD §4.2). */
  managerNeeded: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const ready = reason.trim().length >= REASON_MIN;
  const confirm = () => {
    if (ready) onConfirm(reason.trim());
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={t(ending === 'CANCEL' ? 'mobile.item.cancelTitle' : 'mobile.item.voidTitle', {
        name: line.name,
      })}
      footer={
        <>
          <Button variant="secondary" onPress={onClose} style={styles.grow}>
            {t('mobile.item.keep')}
          </Button>
          <Button
            variant="danger"
            testID="end-item-confirm"
            disabled={!ready}
            onPress={confirm}
            style={styles.grow}
          >
            {t(ending === 'CANCEL' ? 'mobile.item.cancelConfirm' : 'mobile.item.voidConfirm')}
          </Button>
        </>
      }
    >
      <Note>{t(ending === 'CANCEL' ? 'mobile.item.cancelNote' : 'mobile.item.voidNote')}</Note>
      {ending === 'VOID' && managerNeeded ? <Note>{t('mobile.item.managerNote')}</Note> : null}
      <View accessibilityLabel={t('mobile.item.quickReasons')} style={styles.quick}>
        {QUICK[ending].map((key) => {
          const text = t(`mobile.item.quick.${key}`);
          return (
            <Button
              key={key}
              variant="secondary"
              selected={reason === text}
              onPress={() => {
                setReason(text);
              }}
            >
              {text}
            </Button>
          );
        })}
      </View>
      <TextField
        label={t('mobile.item.reason')}
        hint={t('mobile.item.reasonHint')}
        value={reason}
        onChangeText={setReason}
        maxLength={REASON_MAX}
        testID="end-item-reason"
        returnKeyType="done"
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  quick: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
