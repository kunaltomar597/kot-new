import type { PendingApprovalsResponse } from '@rp/contracts';
import { fontSize, fontWeight, radius, spacing } from '@rp/design-tokens';
import { formatRupees } from '@rp/domain';
import type { Translator } from '@rp/i18n';
import { messageOf, Note, useDeviceSession, useLive, useNow, useT } from '@rp/mobile-shell';
import {
  affectsApprovals,
  alertAge,
  anythingLeft,
  approvalChanges,
  approvalsFor,
  approvalTotal,
  waitingLines,
} from '@rp/ordering';
import {
  Button,
  ChoiceGroup,
  QuantityStepper,
  TextField,
  toneColors,
  useTheme,
  useToast,
  weight,
} from '@rp/ui-native';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

type Entry = PendingApprovalsResponse['orders'][number];
type Mode =
  | { readonly kind: 'view' }
  | { readonly kind: 'change'; readonly quantities: ReadonlyMap<string, number> }
  | { readonly kind: 'reject'; readonly reason: string };

const AGE_TICK_MS = 30_000;
const AGREED = 'agreed';

/** "Table T2 · Order 12", as the alert for it names the table. */
export function approvalTitle(entry: Entry, t: Translator): string {
  return entry.tableLabel === null
    ? t('approvals.orderTakeaway', { number: entry.order.orderNumber })
    : t('approvals.order', { table: entry.tableLabel, number: entry.order.orderNumber });
}

/**
 * The approvals inbox (WTR-004, ORD-003): diners' orders from the tablet waiting for the waiter,
 * oldest first. Approve sends one to the kitchen in one tap (NFR-U03); Change sets quantities or
 * removes lines with the diner's agreement first; Reject asks for the reason the diner sees.
 * `sessionId` narrows it to one table.
 */
export function Approvals({ sessionId }: { sessionId?: string }) {
  const session = useDeviceSession();
  const t = useT();
  const { colors } = useTheme();
  const now = useNow(AGE_TICK_MS);
  const { data, reload } = useLive(
    async () => (await session.api.listPendingApprovals()).orders,
    affectsApprovals,
  );
  if (data.status === 'loading') return null;
  if (data.status === 'error') {
    return (
      <View testID="approvals-failed" style={styles.failed}>
        <Note tone="danger">{t('approvals.unavailable')}</Note>
        <Button variant="secondary" onPress={reload}>
          {t('states.retry')}
        </Button>
      </View>
    );
  }
  const entries = approvalsFor(data.value, sessionId);
  if (entries.length === 0) return null;
  const tone = toneColors(colors, 'warning');
  return (
    <View
      testID="approvals"
      style={[styles.card, { backgroundColor: tone.subtle, borderColor: tone.solid }]}
    >
      <Text accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>
        {t('approvals.title', { count: entries.length })}
      </Text>
      {entries.map((entry) => (
        <Approval key={entry.order.id} entry={entry} now={now} onDone={reload} />
      ))}
    </View>
  );
}

function Approval({ entry, now, onDone }: { entry: Entry; now: number; onDone: () => void }) {
  const session = useDeviceSession();
  const t = useT();
  const toast = useToast();
  const { colors } = useTheme();
  const [mode, setMode] = useState<Mode>({ kind: 'view' });
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lines = waitingLines(entry.order);
  const title = approvalTitle(entry, t);
  const number = entry.order.orderNumber;
  const quantities = mode.kind === 'change' ? mode.quantities : new Map<string, number>();

  const run = (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    work().then(
      () => {
        setBusy(false);
        toast.show({ title: done, tone: 'success' });
        onDone();
      },
      (failure: unknown) => {
        setBusy(false);
        setError(t('approvals.failed', { message: messageOf(failure, t) }));
        onDone();
      },
    );
  };
  const approve = () => {
    const changes = approvalChanges(lines, quantities);
    run(
      () =>
        session.api.approveOrder({
          params: { orderId: entry.order.id },
          body: { changes, dinerAgreed: changes.length > 0 && agreed },
        }),
      t('approvals.approved', { number }),
    );
  };

  return (
    <View
      testID={`approval-${entry.order.id}`}
      style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      <Text style={{ color: colors.textMuted }}>
        {t('approvals.waited', {
          age: alertAge(entry.order.createdAt, now, t),
          total: formatRupees(approvalTotal(lines, quantities)),
        })}
      </Text>
      {lines.map((line) => (
        <View key={line.id} style={styles.line}>
          <View style={styles.grow}>
            <Text style={{ color: colors.text, fontSize: fontSize.md }}>
              {t('approvals.line', {
                quantity: quantities.get(line.id) ?? line.quantity,
                name: line.name,
              })}
            </Text>
            {(line.details !== '' || line.instructions !== null) && (
              <Text style={{ color: colors.textMuted }}>
                {[line.details, line.instructions]
                  .filter((part) => part !== '' && part !== null)
                  .join(' · ')}
              </Text>
            )}
          </View>
          {mode.kind === 'change' && (
            <QuantityStepper
              value={quantities.get(line.id) ?? line.quantity}
              min={0}
              max={99}
              label={t('approvals.quantityOf', { name: line.name })}
              decreaseLabel={t('pos.item.fewer')}
              increaseLabel={t('pos.item.more')}
              onChange={(value) => {
                setMode({ kind: 'change', quantities: new Map([...quantities, [line.id, value]]) });
              }}
            />
          )}
        </View>
      ))}
      {error !== null && <Note tone="danger">{error}</Note>}
      {mode.kind === 'view' && (
        <View style={styles.actions}>
          <Button
            style={styles.grow}
            testID={`approval-${entry.order.id}-approve`}
            accessibilityLabel={t('approvals.approveOf', { title })}
            loading={busy}
            onPress={approve}
          >
            {t('approvals.approve')}
          </Button>
          <Button
            variant="secondary"
            style={styles.grow}
            disabled={busy}
            accessibilityLabel={t('approvals.changeOf', { title })}
            testID={`approval-${entry.order.id}-change`}
            onPress={() => {
              setMode({ kind: 'change', quantities: new Map() });
            }}
          >
            {t('approvals.change')}
          </Button>
          <Button
            variant="secondary"
            style={styles.grow}
            disabled={busy}
            accessibilityLabel={t('approvals.rejectOf', { title })}
            testID={`approval-${entry.order.id}-reject`}
            onPress={() => {
              setMode({ kind: 'reject', reason: '' });
            }}
          >
            {t('approvals.reject')}
          </Button>
        </View>
      )}
      {mode.kind === 'change' && (
        <>
          {!anythingLeft(lines, quantities) && (
            <Note tone="danger">{t('approvals.nothingLeft')}</Note>
          )}
          <ChoiceGroup
            legend={t('approvals.agreement')}
            mode="multiple"
            options={[{ id: AGREED, label: t('approvals.dinerAgreed') }]}
            value={agreed ? [AGREED] : []}
            onChange={(value) => {
              setAgreed(value.includes(AGREED));
            }}
          />
          <Button
            testID={`approval-${entry.order.id}-approve-changes`}
            loading={busy}
            disabled={
              !anythingLeft(lines, quantities) ||
              (approvalChanges(lines, quantities).length > 0 && !agreed)
            }
            onPress={approve}
          >
            {t('approvals.approveChanges')}
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onPress={() => {
              setMode({ kind: 'view' });
              setAgreed(false);
            }}
          >
            {t('approvals.keepAsOrdered')}
          </Button>
        </>
      )}
      {mode.kind === 'reject' && (
        <>
          <TextField
            label={t('approvals.reason')}
            value={mode.reason}
            maxLength={200}
            testID={`approval-${entry.order.id}-reason`}
            onChangeText={(reason) => {
              setMode({ kind: 'reject', reason });
            }}
          />
          <Button
            variant="danger"
            testID={`approval-${entry.order.id}-reject-confirm`}
            loading={busy}
            disabled={mode.reason.trim().length < 3}
            onPress={() => {
              run(
                () =>
                  session.api.rejectOrder({
                    params: { orderId: entry.order.id },
                    body: { reason: mode.reason.trim() },
                  }),
                t('approvals.rejected', { number }),
              );
            }}
          >
            {t('approvals.rejectConfirm')}
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onPress={() => {
              setMode({ kind: 'view' });
            }}
          >
            {t('approvals.cancel')}
          </Button>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing[2], padding: spacing[3], borderWidth: 1, borderRadius: radius.lg },
  heading: { fontSize: fontSize.lg, fontWeight: weight(fontWeight.semibold) },
  row: { gap: spacing[2], padding: spacing[3], borderWidth: 1, borderRadius: radius.md },
  title: { fontSize: fontSize.md, fontWeight: weight(fontWeight.semibold) },
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  actions: { flexDirection: 'row', gap: spacing[2] },
  grow: { flex: 1 },
  failed: { gap: spacing[2] },
});
