import { IndianMobile } from '@rp/contracts';
import { fontSize, fontWeight, radius, spacing } from '@rp/design-tokens';
import { type KeyValueStore, TABLET_GUEST_KEYS } from '@rp/mobile-core';
import { messageOf, Note, useDeviceSession, useT } from '@rp/mobile-shell';
import { Button, ChoiceGroup, TextField, useTheme, weight } from '@rp/ui-native';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

/** Kept with the guests' data, so it is asked once per visit and wiped with the rest. */
export const FEEDBACK_KEY = TABLET_GUEST_KEYS[2];
const AGREED = 'agreed';

/** Five large stars for one rating; each is a button that says what it gives. */
function Stars({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const t = useT();
  const { colors } = useTheme();
  return (
    <View style={styles.stars} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      {[1, 2, 3, 4, 5].map((count) => (
        <Pressable
          key={count}
          testID={`${label}-${String(count)}`}
          accessibilityRole="radio"
          accessibilityState={{ checked: value === count }}
          accessibilityLabel={t('mobile.tablet.feedback.star', { label, count })}
          onPress={() => {
            onChange(count);
          }}
          style={styles.star}
        >
          <Text style={{ fontSize: 40, color: count <= value ? colors.accent : colors.border }}>
            ★
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * Feedback after the bill (TAB-014): food and service out of 5, a comment, and a number only if
 * the diner ticks the consent beside it, whose words are kept with it (BILL-011, SEC-019). Asked
 * once per visit; it thanks and goes away once sent.
 */
export function FeedbackCard({ store, guestEpoch }: { store: KeyValueStore; guestEpoch: number }) {
  const t = useT();
  const session = useDeviceSession();
  const { colors } = useTheme();
  const [sent, setSent] = useState<boolean | null>(null);
  const [food, setFood] = useState(0);
  const [service, setService] = useState(0);
  const [comment, setComment] = useState('');
  const [phone, setPhone] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    store.getItem(FEEDBACK_KEY).then(
      (value) => {
        if (active) setSent(value !== null);
      },
      () => {
        if (active) setSent(false);
      },
    );
    return () => {
      active = false;
    };
  }, [store, guestEpoch]);

  if (sent === null) return null;
  if (sent) {
    return (
      <Note tone="text" testID="feedback-thanks">
        {t('mobile.tablet.feedback.thanks')}
      </Note>
    );
  }

  const send = () => {
    const number = phone.trim();
    if (food === 0 || service === 0) {
      setProblem(t('mobile.tablet.feedback.rateBoth'));
      return;
    }
    if (number !== '' && !IndianMobile.safeParse(number).success) {
      setProblem(IndianMobile.safeParse(number).error?.issues[0]?.message ?? null);
      return;
    }
    if (number !== '' && !agreed) {
      setProblem(t('mobile.tablet.feedback.consentNeeded'));
      return;
    }
    setBusy(true);
    setProblem(null);
    session.api
      .submitTabletFeedback({
        body: {
          foodRating: food,
          serviceRating: service,
          ...(comment.trim() !== '' && { comment: comment.trim() }),
          ...(number !== '' && {
            phone: number,
            consent: true,
            consentText: t('mobile.tablet.feedback.consent'),
          }),
        },
      })
      .then(() => store.setItem(FEEDBACK_KEY, 'sent'))
      .then(
        () => {
          setBusy(false);
          setSent(true);
        },
        (failure: unknown) => {
          setBusy(false);
          setProblem(messageOf(failure, t));
        },
      );
  };

  return (
    <View
      testID="feedback"
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.accent }]}
    >
      <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
        {t('mobile.tablet.feedback.title')}
      </Text>
      <Stars label={t('mobile.tablet.feedback.food')} value={food} onChange={setFood} />
      <Stars label={t('mobile.tablet.feedback.service')} value={service} onChange={setService} />
      <TextField
        label={t('mobile.tablet.feedback.comment')}
        value={comment}
        onChangeText={setComment}
        maxLength={500}
        multiline
        testID="feedback-comment"
      />
      <TextField
        label={t('mobile.tablet.feedback.phone')}
        hint={t('mobile.tablet.feedback.phoneHint')}
        value={phone}
        onChangeText={setPhone}
        keyboardType="number-pad"
        maxLength={16}
        testID="feedback-phone"
      />
      {phone.trim() !== '' && (
        <ChoiceGroup
          legend={t('mobile.tablet.feedback.consentLegend')}
          mode="multiple"
          options={[{ id: AGREED, label: t('mobile.tablet.feedback.consent') }]}
          value={agreed ? [AGREED] : []}
          onChange={(value) => {
            setAgreed(value.includes(AGREED));
          }}
        />
      )}
      {problem !== null && <Note tone="danger">{problem}</Note>}
      <Button size="lg" testID="feedback-send" loading={busy} onPress={send}>
        {t('mobile.tablet.feedback.send')}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing[3], padding: spacing[4], borderWidth: 2, borderRadius: radius.lg },
  title: { fontSize: fontSize['2xl'], fontWeight: weight(fontWeight.bold) },
  stars: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  label: { width: 90, fontSize: fontSize.lg },
  star: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
});
