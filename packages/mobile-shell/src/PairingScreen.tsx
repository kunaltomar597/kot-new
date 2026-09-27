import { Button, TextField } from '@rp/ui-native';
import { useState } from 'react';
import { useDeviceSession, useSessionState, useT } from './context.js';
import { formatPairingCode, messageOf } from './messages.js';
import { Note, Screen } from './Screen.js';

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
      <TextField
        label={t('mobile.serverLabel')}
        hint={t('mobile.serverHint')}
        value={server}
        onChangeText={setServer}
        testID="pairing-server"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <TextField
        label={t('pairing.codeLabel')}
        value={code}
        onChangeText={(value) => {
          setCode(formatPairingCode(value));
        }}
        testID="pairing-code"
        autoCapitalize="characters"
        autoCorrect={false}
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
