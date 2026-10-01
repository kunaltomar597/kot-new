import type { ServiceRequestView } from '@rp/contracts';
import { fontSize, radius, spacing } from '@rp/design-tokens';
import type { ServiceRequestType } from '@rp/domain';
import { messageOf, Note, useDeviceSession, useLive, useNow, useT } from '@rp/mobile-shell';
import { Button, useTheme } from '@rp/ui-native';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  cancelPlan,
  REQUEST_BUTTONS,
  type RequestButtonState,
  requestButtonState,
} from './service-view';

const REQUEST_EVENTS = new Set([
  'ServiceRequestRaised',
  'ServiceRequestAcknowledged',
  'ServiceRequestEscalated',
  'ServiceRequestCancelled',
]);

/**
 * The cabin-call buttons (TAB-004, BILL-015): Water, Waiter and Bill call the table's waiter (and
 * the cashier for the bill) and stay lit, "Requested, waiter notified" with the time, until the
 * waiter acknowledges ("on the way") and the request is cancelled or resolved. Cancel clears the
 * only open request, or asks which one. The server refuses a second request of the same kind.
 */
export function ServiceButtons() {
  const t = useT();
  const session = useDeviceSession();
  const { colors } = useTheme();
  const now = useNow(30_000);
  const { data, reload } = useLive(
    () => session.api.listTableServiceRequests(),
    (type) => REQUEST_EVENTS.has(type),
  );
  const [busy, setBusy] = useState<ServiceRequestType | 'CANCEL' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const requests = data.status === 'ready' ? data.value.requests : [];
  const label = (type: ServiceRequestType) => t(`mobile.tablet.requests.label.${type}`);
  const stateText = (state: RequestButtonState) =>
    state.kind === 'requested'
      ? t('mobile.tablet.requests.requested', { minutes: state.minutes })
      : state.kind === 'onTheWay'
        ? state.name === null
          ? t('mobile.tablet.requests.onTheWay')
          : t('mobile.tablet.requests.onTheWayNamed', { name: state.name })
        : null;

  const act = (what: ServiceRequestType | 'CANCEL', work: () => Promise<unknown>) => {
    setBusy(what);
    setMessage(null);
    work().then(
      () => {
        setBusy(null);
        reload();
      },
      (failure: unknown) => {
        setBusy(null);
        setMessage(t('mobile.tablet.requests.notSent', { message: messageOf(failure, t) }));
        reload();
      },
    );
  };
  const cancel = (request: ServiceRequestView) => {
    setChoosing(false);
    act('CANCEL', () =>
      session.api.cancelTableServiceRequest({ params: { requestId: request.id } }),
    );
  };
  const plan = cancelPlan(requests);

  return (
    <View style={styles.panel} testID="service-buttons">
      <View style={styles.grid}>
        {REQUEST_BUTTONS.map((type) => {
          const state = requestButtonState(type, requests, now);
          const shown = stateText(state);
          return (
            <View
              key={type}
              style={[
                styles.cell,
                {
                  borderColor: state.kind === 'idle' ? colors.border : colors.accent,
                  backgroundColor: colors.surface,
                },
              ]}
            >
              <Button
                testID={`request-${type}`}
                size="lg"
                fullWidth
                variant={state.kind === 'idle' ? 'primary' : 'secondary'}
                loading={busy === type}
                disabled={state.kind !== 'idle' || busy !== null}
                accessibilityLabel={
                  shown === null
                    ? label(type)
                    : t('mobile.tablet.requests.stateOf', { request: label(type), state: shown })
                }
                onPress={() => {
                  act(type, () => session.api.raiseServiceRequest({ body: { type } }));
                }}
              >
                {label(type)}
              </Button>
              {shown !== null && (
                <Text
                  accessibilityLiveRegion="polite"
                  style={[styles.state, { color: colors.accent }]}
                  testID={`request-${type}-state`}
                >
                  {shown}
                </Text>
              )}
            </View>
          );
        })}
        <View
          style={[styles.cell, { borderColor: colors.border, backgroundColor: colors.surface }]}
        >
          <Button
            testID="request-cancel"
            size="lg"
            fullWidth
            variant="secondary"
            loading={busy === 'CANCEL'}
            disabled={plan.kind === 'none' || busy !== null}
            onPress={() => {
              if (plan.kind === 'one') cancel(plan.request);
              else if (plan.kind === 'choose') setChoosing(true);
            }}
          >
            {t('mobile.tablet.requests.cancel')}
          </Button>
        </View>
      </View>
      {message !== null && <Note tone="danger">{message}</Note>}
      {choosing && plan.kind === 'choose' && (
        <View
          testID="cancel-choice"
          accessibilityRole="alert"
          style={[styles.choice, { backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <Note tone="text">{t('mobile.tablet.requests.chooseCancel')}</Note>
          {plan.requests.map((request) => (
            <Button
              key={request.id}
              testID={`cancel-${request.type}`}
              size="lg"
              fullWidth
              variant="secondary"
              onPress={() => {
                cancel(request);
              }}
            >
              {t('mobile.tablet.requests.cancelThis', { request: label(request.type) })}
            </Button>
          ))}
          <Button
            variant="secondary"
            fullWidth
            onPress={() => {
              setChoosing(false);
            }}
          >
            {t('mobile.tablet.requests.keep')}
          </Button>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: spacing[3] },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[3] },
  cell: {
    flexBasis: '47%',
    flexGrow: 1,
    gap: spacing[2],
    padding: spacing[3],
    borderWidth: 2,
    borderRadius: radius.lg,
  },
  state: { fontSize: fontSize.lg, textAlign: 'center' },
  choice: { gap: spacing[2], padding: spacing[4], borderWidth: 1, borderRadius: radius.lg },
});
