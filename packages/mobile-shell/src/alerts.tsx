import type { AlertView } from '@rp/contracts';
import { fontSize, fontWeight, radius, spacing, touchTarget } from '@rp/design-tokens';
import type { AlertCenterSnapshot } from '@rp/mobile-core';
import { alertAge, describeAlert } from '@rp/ordering';
import { Button, Glyph, Sheet, useTheme, weight } from '@rp/ui-native';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useDeviceSession, useSessionState, useT } from './context.js';
import { messageOf } from './messages.js';
import { useNow } from './use-now.js';

/** How often the alerts' ages ("4 min ago") are brought up to date. */
const AGE_TICK_MS = 30_000;

/** The alerts of the person this phone alerts (P2-06a, WTR-006); re-renders when they change. */
export function useAlerts(): AlertCenterSnapshot {
  const session = useDeviceSession();
  return useSyncExternalStore(session.alerts.subscribe, session.alerts.getSnapshot);
}

interface Acknowledging {
  /** Alerts whose acknowledgement is on its way. */
  readonly pending: ReadonlySet<string>;
  /** What went wrong with the last one, in plain words (NFR-U04). */
  readonly error: string | null;
  readonly acknowledge: (alertId: string) => void;
}

/** Acknowledging as the phone's holder, from the banner or the list (NTF-004). */
function useAcknowledge(): Acknowledging {
  const session = useDeviceSession();
  const t = useT();
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const acknowledge = useCallback(
    (alertId: string) => {
      setError(null);
      setPending((current) => new Set([...current, alertId]));
      void session.alerts
        .acknowledge(alertId)
        .catch((failure: unknown) => {
          setError(t('alerts.acknowledgeFailed', { message: messageOf(failure, t) }));
        })
        .finally(() => {
          setPending((current) => new Set([...current].filter((id) => id !== alertId)));
        });
    },
    [session, t],
  );
  return { pending, error, acknowledge };
}

/** The holder's name when someone else, or nobody, is signed in: whose alerts these are. */
function useOtherHolder(): string | null {
  const { holder } = useAlerts();
  const { person } = useSessionState();
  return holder !== null && holder.staffId !== person?.id ? holder.displayName : null;
}

/**
 * The newest open alert of the person the phone alerts, on every screen (WTR-006): where and what,
 * how many more, and Acknowledge in one tap (NFR-U03); a tap on it lists them all. It shows on the
 * sign-in screen too, since the phone goes on alerting after an inactivity sign-out (AUTH-005).
 * Nothing shows when no alert is open, or on a device that follows none (the table tablet).
 */
export function AlertBanner() {
  const { alerts } = useAlerts();
  const [listOpen, setListOpen] = useState(false);
  const acknowledging = useAcknowledge();
  const openList = useCallback(() => {
    setListOpen(true);
  }, []);
  const closeList = useCallback(() => {
    setListOpen(false);
  }, []);
  const newest = alerts.at(-1);
  return (
    <>
      {newest === undefined ? null : (
        <Banner
          alert={newest}
          more={alerts.length - 1}
          acknowledging={acknowledging}
          onOpenList={openList}
        />
      )}
      {listOpen ? <AlertsSheet acknowledging={acknowledging} onClose={closeList} /> : null}
    </>
  );
}

function Banner({
  alert,
  more,
  acknowledging,
  onOpenList,
}: {
  alert: AlertView;
  more: number;
  acknowledging: Acknowledging;
  onOpenList: () => void;
}) {
  const t = useT();
  const { colors } = useTheme();
  const now = useNow(AGE_TICK_MS);
  const holder = useOtherHolder();
  const { title, detail } = describeAlert(alert, t);
  const facts = [
    detail,
    alertAge(alert.createdAt, now, t),
    more > 0 ? t('alerts.more', { count: more }) : null,
    holder === null ? null : t('alerts.for', { name: holder }),
  ].filter((fact) => fact !== null);
  return (
    <View testID="alert-banner" style={[styles.banner, { backgroundColor: colors.warning }]}>
      <View style={styles.bannerRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={[title, ...facts, t('alerts.showAll', { count: more + 1 })].join(
            '. ',
          )}
          accessibilityHint={t('alerts.showAll', { count: more + 1 })}
          onPress={onOpenList}
          testID="alert-banner-open"
          style={styles.bannerText}
        >
          <Text
            accessibilityLiveRegion="assertive"
            numberOfLines={2}
            style={[styles.title, { color: colors.onWarning }]}
          >
            <Glyph name="bell" color={colors.onWarning} size={fontSize.md} /> {title}
          </Text>
          <Text numberOfLines={2} style={[styles.facts, { color: colors.onWarning }]}>
            {facts.join(' · ')}
          </Text>
        </Pressable>
        <Button
          variant="secondary"
          loading={acknowledging.pending.has(alert.id)}
          onPress={() => {
            acknowledging.acknowledge(alert.id);
          }}
          accessibilityLabel={t('alerts.acknowledgeOf', { title })}
          testID="alert-banner-acknowledge"
        >
          {t('alerts.acknowledge')}
        </Button>
      </View>
      {acknowledging.error === null ? null : (
        <Text
          accessibilityRole="alert"
          testID="alert-banner-error"
          style={[styles.error, { backgroundColor: colors.dangerSubtle, color: colors.dangerText }]}
        >
          {acknowledging.error}
        </Text>
      )}
    </View>
  );
}

/** Every open alert, newest first, with its age, reminders and escalation. */
function AlertsSheet({
  acknowledging,
  onClose,
}: {
  acknowledging: Acknowledging;
  onClose: () => void;
}) {
  const { alerts } = useAlerts();
  const holder = useOtherHolder();
  const t = useT();
  const { colors } = useTheme();
  const now = useNow(AGE_TICK_MS);
  return (
    <Sheet
      open
      onClose={onClose}
      title={holder === null ? t('alerts.title') : t('alerts.titleFor', { name: holder })}
    >
      {holder === null ? null : (
        <Text style={[styles.note, { color: colors.textMuted }]}>
          {t('alerts.holderNote', { name: holder })}
        </Text>
      )}
      {alerts.length === 0 ? (
        <Text testID="alerts-none" style={[styles.note, { color: colors.textMuted }]}>
          {t('alerts.none')}
        </Text>
      ) : null}
      {[...alerts].reverse().map((alert) => (
        <AlertRow key={alert.id} alert={alert} now={now} acknowledging={acknowledging} />
      ))}
      {acknowledging.error === null ? null : (
        <Text accessibilityRole="alert" style={[styles.note, { color: colors.dangerText }]}>
          {acknowledging.error}
        </Text>
      )}
    </Sheet>
  );
}

function AlertRow({
  alert,
  now,
  acknowledging,
}: {
  alert: AlertView;
  now: number;
  acknowledging: Acknowledging;
}) {
  const t = useT();
  const { colors } = useTheme();
  const { title, detail } = describeAlert(alert, t);
  const facts = [
    alertAge(alert.createdAt, now, t),
    alert.repeatCount > 0 ? t('alerts.reminded', { count: alert.repeatCount }) : null,
    alert.escalatedAt === null ? null : t('alerts.escalated'),
  ].filter((fact) => fact !== null);
  return (
    <View
      testID={`alert-${alert.id}`}
      style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <View style={styles.rowText}>
        <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
        {detail === null ? null : (
          <Text style={[styles.facts, { color: colors.text }]}>{detail}</Text>
        )}
        <Text style={[styles.facts, { color: colors.textMuted }]}>{facts.join(' · ')}</Text>
      </View>
      <Button
        loading={acknowledging.pending.has(alert.id)}
        onPress={() => {
          acknowledging.acknowledge(alert.id);
        }}
        accessibilityLabel={t('alerts.acknowledgeOf', { title })}
        testID={`alert-${alert.id}-acknowledge`}
      >
        {t('alerts.acknowledge')}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { paddingHorizontal: spacing[3], paddingVertical: spacing[2], gap: spacing[2] },
  bannerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  bannerText: { flex: 1, minHeight: touchTarget.min, justifyContent: 'center' },
  title: { fontSize: fontSize.md, fontWeight: weight(fontWeight.bold) },
  facts: { fontSize: fontSize.sm },
  error: { padding: spacing[2], borderRadius: radius.md, fontSize: fontSize.sm },
  note: { fontSize: fontSize.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[3],
    borderWidth: 1,
    borderRadius: radius.lg,
  },
  rowText: { flex: 1, gap: spacing[1] },
});
