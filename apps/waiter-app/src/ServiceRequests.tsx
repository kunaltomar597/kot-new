import type { ServiceRequestView } from '@rp/contracts';
import { fontSize, fontWeight, radius, spacing } from '@rp/design-tokens';
import { SERVICE_REQUEST_ALERTS } from '@rp/domain';
import type { Translator } from '@rp/i18n';
import { messageOf, Note, useDeviceSession, useLive, useNow, useT } from '@rp/mobile-shell';
import { alertAge } from '@rp/ordering';
import { Button, toneColors, useTheme, weight } from '@rp/ui-native';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

/** Ages ("4 min ago") move on every half minute. */
const AGE_TICK_MS = 30_000;

type Action = 'acknowledge' | 'resolve';

/** Events after which the open requests are read again: their own, and a table moved or closed. */
export const affectsRequests = (eventType: string) =>
  /^(ServiceRequest|TableMoved$|TableClosed$)/.test(eventType);

/** "Table T2 · Water requested", as the alert for it says on the banner and the pager. */
export function requestTitle(request: ServiceRequestView, t: Translator): string {
  return t('alerts.atTable', {
    table: request.tableLabel,
    what: t(`alerts.type.${SERVICE_REQUEST_ALERTS[request.type]}`),
  });
}

/** How long it has waited, and whether someone is on the way or the managers were alerted. */
function requestFacts(request: ServiceRequestView, now: number, t: Translator): string {
  const facts = [alertAge(request.createdAt, now, t)];
  if (request.state === 'ACKNOWLEDGED') {
    facts.push(
      request.acknowledgedByName === null
        ? t('mobile.requests.onTheWaySomeone')
        : t('mobile.requests.onTheWay', { name: request.acknowledgedByName }),
    );
  }
  if (request.state === 'ESCALATED') facts.push(t('alerts.escalated'));
  return facts.join(' · ');
}

/**
 * The waiter's service request inbox (WTR-005): Water, Waiter and Bill asked for at the tables,
 * oldest first, with the table, how long ago, and whether someone is on the way or the managers
 * were alerted. Acknowledge ("on my way") stops the reminders (NTF-004); Resolve clears the
 * request, as Cancel on the tablet does. Shown only while a request is open; `show` narrows it to
 * the tables on the screen.
 */
export function ServiceRequests({ show }: { show?: (request: ServiceRequestView) => boolean }) {
  const session = useDeviceSession();
  const t = useT();
  const { colors } = useTheme();
  const now = useNow(AGE_TICK_MS);
  const { data, reload } = useLive(
    async () => (await session.api.listServiceRequests()).requests,
    affectsRequests,
  );
  const [pending, setPending] = useState<ReadonlyMap<string, Action>>(() => new Map());
  const [error, setError] = useState<string | undefined>();

  const act = (request: ServiceRequestView, action: Action) => {
    setError(undefined);
    setPending((current) => new Map([...current, [request.id, action]]));
    const call = { params: { requestId: request.id } };
    const sent =
      action === 'acknowledge'
        ? session.api.acknowledgeServiceRequest(call)
        : session.api.resolveServiceRequest(call);
    void sent
      .catch((failure: unknown) => {
        const message = messageOf(failure, t);
        setError(
          action === 'acknowledge'
            ? t('alerts.acknowledgeFailed', { message })
            : t('mobile.requests.resolveFailed', { message }),
        );
      })
      .finally(() => {
        setPending((current) => new Map([...current].filter(([id]) => id !== request.id)));
        // Taken or ended elsewhere meanwhile: show the requests as they are now.
        reload();
      });
  };

  if (data.status === 'loading') return null;
  if (data.status === 'error') {
    return (
      <View testID="service-requests-failed" style={styles.failed}>
        <Note tone="danger">{t('mobile.requests.unavailable')}</Note>
        <Button variant="secondary" onPress={reload}>
          {t('states.retry')}
        </Button>
      </View>
    );
  }
  const requests = show === undefined ? data.value : data.value.filter(show);
  if (requests.length === 0) return null;
  const waiting = requests.some((request) => request.state !== 'ACKNOWLEDGED');
  const tone = toneColors(colors, waiting ? 'warning' : 'info');
  return (
    <View
      testID="service-requests"
      style={[styles.card, { backgroundColor: tone.subtle, borderColor: tone.solid }]}
    >
      <Text accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>
        {t('mobile.requests.title', { count: requests.length })}
      </Text>
      {requests.map((request) => {
        const title = requestTitle(request, t);
        const busy = pending.get(request.id);
        const acknowledged = request.state === 'ACKNOWLEDGED';
        return (
          <View
            key={request.id}
            testID={`request-${request.id}`}
            style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
            <Text style={[styles.facts, { color: colors.textMuted }]}>
              {requestFacts(request, now, t)}
            </Text>
            <View style={styles.actions}>
              {acknowledged ? null : (
                <Button
                  style={styles.grow}
                  loading={busy === 'acknowledge'}
                  disabled={busy !== undefined}
                  accessibilityLabel={t('alerts.acknowledgeOf', { title })}
                  testID={`request-${request.id}-acknowledge`}
                  onPress={() => {
                    act(request, 'acknowledge');
                  }}
                >
                  {t('alerts.acknowledge')}
                </Button>
              )}
              <Button
                variant={acknowledged ? 'primary' : 'secondary'}
                style={styles.grow}
                loading={busy === 'resolve'}
                disabled={busy !== undefined}
                accessibilityLabel={t('mobile.requests.resolveOf', { title })}
                testID={`request-${request.id}-resolve`}
                onPress={() => {
                  act(request, 'resolve');
                }}
              >
                {t('mobile.requests.resolve')}
              </Button>
            </View>
          </View>
        );
      })}
      {error === undefined ? null : (
        <Text accessibilityRole="alert" style={[styles.facts, { color: colors.dangerText }]}>
          {error}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.lg, padding: spacing[3], gap: spacing[2] },
  heading: { fontSize: fontSize.lg, fontWeight: weight(fontWeight.semibold) },
  row: { borderWidth: 1, borderRadius: radius.md, padding: spacing[3], gap: spacing[1] },
  title: { fontSize: fontSize.md, fontWeight: weight(fontWeight.bold) },
  facts: { fontSize: fontSize.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2], marginTop: spacing[1] },
  grow: { flex: 1 },
  failed: { gap: spacing[2] },
});
