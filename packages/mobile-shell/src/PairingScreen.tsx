import { fontSize, radius, spacing } from '@rp/design-tokens';
import { Button, useTheme } from '@rp/ui-native';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useDeviceSession, useSessionState, useT } from './context.js';
import { formatPairingCode, messageOf } from './messages.js';
import { Note, Screen } from './Screen.js';

function Field({
  label,
  hint,
  value,
  onChangeText,
  testID,
  autoCapitalize,
  keyboardType,
}: {
  label: string;
  hint?: string;
  value: string;
  onChangeText: (value: string) => void;
  testID: string;
  autoCapitalize: 'none' | 'characters';
  keyboardType: 'url' | 'default';
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.field}>
      <Text nativeID={`${testID}-label`} style={[styles.label, { color: colors.text }]}>
        {label}
      </Text>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        accessibilityLabelledBy={`${testID}-label`}
        {...(hint !== undefined && { accessibilityHint: hint })}
        value={value}
        onChangeText={onChangeText}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        keyboardType={keyboardType}
        style={[
          styles.input,
          { borderColor: colors.borderStrong, color: colors.text, backgroundColor: colors.surface },
        ]}
      />
      {hint !== undefined && <Note>{hint}</Note>}
    </View>
  );
}

/**
 * Pairing with the local server (AUTH-007): the server address and the code a manager created in
 * Manage → Devices. The device key is created in the Keystore as part of pairing.
 */
export function PairingScreen() {
  const session = useDeviceSession();
  const { notice } = useSessionState();
  const t = useT();
  const [server, setServer] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const pair = () => {
    setWorking(true);
    setError(null);
    session.pair(server, code).then(
      () => {
        setWorking(false);
      },
      (failure: unknown) => {
        setWorking(false);
        setError(messageOf(failure, t));
      },
    );
  };

  return (
    <Screen title={t('pairing.title')}>
      {notice === 'revoked' && <Note tone="danger">{t('pairing.revoked')}</Note>}
      <Note>{t('pairing.intro')}</Note>
      <Field
        label={t('mobile.serverLabel')}
        hint={t('mobile.serverHint')}
        value={server}
        onChangeText={setServer}
        testID="pairing-server"
        autoCapitalize="none"
        keyboardType="url"
      />
      <Field
        label={t('pairing.codeLabel')}
        value={code}
        onChangeText={(value) => {
          setCode(formatPairingCode(value));
        }}
        testID="pairing-code"
        autoCapitalize="characters"
        keyboardType="default"
      />
      {error !== null && (
        <Note tone="danger" testID="pairing-error">
          {error}
        </Note>
      )}
      <Button
        testID="pairing-submit"
        size="lg"
        fullWidth
        loading={working}
        disabled={server.trim() === '' || code.length !== 9}
        onPress={pair}
      >
        {working ? t('pairing.working') : t('pairing.submit')}
      </Button>
    </Screen>
  );
}

const styles = StyleSheet.create({
  field: { gap: spacing[1] },
  label: { fontSize: fontSize.md },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing[3],
    fontSize: fontSize.lg,
  },
});
