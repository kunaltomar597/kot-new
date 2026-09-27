import { fontSize, fontWeight, radius, spacing } from '@rp/design-tokens';
import type { Translator } from '@rp/i18n';
import type { OrderDraft, OutboxEntry } from '@rp/mobile-core';
import { messageOf, Note, useDeviceSession, useT, useUnsentOrders } from '@rp/mobile-shell';
import { Button, Sheet, toneColors, useTheme, weight } from '@rp/ui-native';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

type Draft = OutboxEntry<OrderDraft>;

/** Where an unsent order is, in words, for the person looking at it (WTR-012). */
function draftState(entry: Draft, personId: string, t: Translator): string {
  if (entry.status === 'SENDING') return t('mobile.order.unsent.sending');
  if (entry.status === 'REJECTED') {
    const problem = entry.body.problem;
    return problem?.kind === 'REFUSED'
      ? t('mobile.order.unsent.refused', { message: problem.message })
      : t('mobile.order.unsent.linesRejected');
  }
  return entry.body.staffId === personId
    ? t('mobile.order.unsent.waiting')
    : t('mobile.order.unsent.otherWaiter');
}

/**
 * A table's orders kept on this phone and not yet taken by the server (WTR-012): waiting for the
 * connection, being sent, or refused with the reason. A refused order is changed (its items go
 * back into the new items) or discarded after a confirmation; nothing is dropped silently.
 */
export function UnsentOrders({
  entries,
  personId,
  onChange,
}: {
  entries: readonly Draft[];
  personId: string;
  /** A refused order goes back to be changed and sent again. */
  onChange: (draft: OrderDraft) => void;
}) {
  const session = useDeviceSession();
  const t = useT();
  const { colors } = useTheme();
  const [discarding, setDiscarding] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const act = (action: () => Promise<unknown>) => {
    setError(undefined);
    action().catch((failure: unknown) => {
      setError(messageOf(failure, t));
    });
  };

  if (entries.length === 0) return null;
  return (
    <View style={styles.section} testID="unsent-orders">
      <Text accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>
        {t('mobile.order.unsent.title')}
      </Text>
      {entries.map((entry) => {
        const refused = entry.status === 'REJECTED';
        const tone = toneColors(colors, refused ? 'danger' : 'warning');
        const problem = entry.body.problem;
        const rejected =
          problem?.kind === 'LINES'
            ? new Map(problem.lines.map((line) => [line.clientLineId, line.message]))
            : new Map<string, string>();
        return (
          <View
            key={entry.key}
            testID={`draft-${entry.key}`}
            style={[styles.draft, { backgroundColor: tone.subtle, borderColor: tone.solid }]}
          >
            <Text accessibilityRole={refused ? 'alert' : 'text'} style={{ color: tone.text }}>
              {draftState(entry, personId, t)}
            </Text>
            {entry.body.lines.map((line) => {
              const reason = rejected.get(line.clientLineId);
              return (
                <Text key={line.clientLineId} style={{ color: colors.text }}>
                  {`${String(line.quantity)} × ${line.name}`}
                  {reason === undefined ? '' : ` · ${reason}`}
                </Text>
              );
            })}
            {refused ? (
              <View style={styles.actions}>
                <Button
                  onPress={() => {
                    act(async () => {
                      const draft = await session.orders.takeBack(entry.key);
                      if (draft !== undefined) onChange(draft);
                    });
                  }}
                >
                  {t('mobile.order.unsent.change')}
                </Button>
                <Button
                  variant="secondary"
                  onPress={() => {
                    setDiscarding(entry.key);
                  }}
                >
                  {t('mobile.order.unsent.discard')}
                </Button>
              </View>
            ) : null}
            {entry.status === 'PENDING' && entry.body.staffId === personId ? (
              <View style={styles.actions}>
                <Button
                  variant="secondary"
                  onPress={() => {
                    act(() => session.orders.flush());
                  }}
                >
                  {t('mobile.order.unsent.sendNow')}
                </Button>
              </View>
            ) : null}
          </View>
        );
      })}
      {error === undefined ? null : <Note tone="danger">{error}</Note>}
      {discarding === undefined ? null : (
        <Sheet
          open
          onClose={() => {
            setDiscarding(undefined);
          }}
          title={t('mobile.order.unsent.discardTitle')}
          footer={
            <>
              <Button
                variant="secondary"
                style={styles.grow}
                onPress={() => {
                  setDiscarding(undefined);
                }}
              >
                {t('mobile.order.unsent.keep')}
              </Button>
              <Button
                variant="danger"
                style={styles.grow}
                testID="discard-confirm"
                onPress={() => {
                  const key = discarding;
                  setDiscarding(undefined);
                  act(() => session.orders.dismiss(key));
                }}
              >
                {t('mobile.order.unsent.discard')}
              </Button>
            </>
          }
        >
          <Note tone="text">{t('mobile.order.unsent.discardBody')}</Note>
        </Sheet>
      )}
    </View>
  );
}

/**
 * On the tables screen: the orders on this phone not yet sent, whoever took them, each opening
 * its table (WTR-012).
 */
export function UnsentHome({ onOpen }: { onOpen: (sessionId: string) => void }) {
  const t = useT();
  const { colors } = useTheme();
  const entries = useUnsentOrders();
  if (entries.length === 0) return null;
  const tone = toneColors(
    colors,
    entries.some((entry) => entry.status === 'REJECTED') ? 'danger' : 'warning',
  );
  return (
    <View
      testID="unsent-home"
      style={[styles.draft, { backgroundColor: tone.subtle, borderColor: tone.solid }]}
    >
      <Text accessibilityRole="alert" style={[styles.heading, { color: tone.text }]}>
        {t('mobile.order.unsent.home', { count: entries.length })}
      </Text>
      {entries.map((entry) => (
        <Button
          key={entry.key}
          variant="secondary"
          onPress={() => {
            const sessionId = entry.body.request.tableSessionId;
            if (sessionId !== undefined) onOpen(sessionId);
          }}
        >
          {t('mobile.order.unsent.entry', {
            table: entry.body.tableLabel,
            state: t(`mobile.order.unsent.state.${entry.status}`),
          })}
        </Button>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing[2] },
  heading: { fontSize: fontSize.lg, fontWeight: weight(fontWeight.semibold) },
  draft: { borderWidth: 1, borderRadius: radius.lg, padding: spacing[3], gap: spacing[2] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  grow: { flex: 1 },
});
