import { parsePairingQr } from '@rp/contracts';
import { fontSize, radius, spacing } from '@rp/design-tokens';
import type { FoundServer, ServerAuthority } from '@rp/mobile-core';
import { Button, TextField, useTheme } from '@rp/ui-native';
import { lazy, Suspense, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useDeviceSession, useSessionState, useT } from './context.js';
import { formatFingerprint, formatPairingCode, messageOf } from './messages.js';
import { Note, Screen } from './Screen.js';

const QrScanner = lazy(() =>
  import('./QrScanner.js').then((module) => ({ default: module.QrScanner })),
);

/** A server that answered with a CA nobody has checked yet. */
type Unchecked = FoundServer & { readonly authority: ServerAuthority };

/**
 * Pairing with the local server (AUTH-007, ADR-0011). Scanning the QR code a manager shows in
 * Manage → Devices gives the code, the server's addresses and its certificate's fingerprint, so the
 * device finds the server and trusts only that certificate. With a typed address, a person compares
 * the certificate's fingerprint with the server PC's before the device trusts it. The device key is
 * created in the Keystore as part of pairing.
 */
export function PairingScreen() {
  const session = useDeviceSession();
  const { notice } = useSessionState();
  const t = useT();
  const { colors } = useTheme();
  const [server, setServer] = useState('');
  const [code, setCode] = useState('');
  /** The fingerprint from a scanned QR code: a typed address is checked against it. */
  const [ca, setCa] = useState<string | undefined>(undefined);
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [unchecked, setUnchecked] = useState<Unchecked | undefined>(undefined);

  const run = (task: () => Promise<void>) => {
    setWorking(true);
    setError(null);
    task().then(
      () => {
        setWorking(false);
      },
      (failure: unknown) => {
        setWorking(false);
        setError(messageOf(failure, t));
      },
    );
  };

  /** Pairs with the server found, unless a person must check its certificate first. */
  const pairWith = async (found: FoundServer, pairingCode: string) => {
    if (found.authority !== undefined && !found.verified) {
      setUnchecked({ ...found, authority: found.authority });
      return;
    }
    await session.pair(found.serverUrl, pairingCode, found.authority);
  };

  const submit = () => {
    run(async () => {
      const found = await session.findServer({
        servers: [server],
        ...(ca !== undefined && { caSha256: ca }),
      });
      await pairWith(found, code);
    });
  };

  const scanned = (data: string) => {
    setScanning(false);
    setHint(null);
    const payload = parsePairingQr(data);
    if (payload === undefined) {
      setError(t('pairing.notPairingCode'));
      return;
    }
    setCode(payload.code);
    setCa(payload.ca);
    const urls = payload.urls ?? [];
    const first = urls[0];
    if (first === undefined) {
      setError(null);
      setHint(t('pairing.enterServer'));
      return;
    }
    setServer(first);
    run(async () => {
      const found = await session.findServer({
        servers: urls,
        ...(payload.ca !== undefined && { caSha256: payload.ca }),
      });
      setServer(found.serverUrl);
      await pairWith(found, payload.code);
    });
  };

  if (unchecked !== undefined) {
    return (
      <Screen title={t('pairing.checkTitle')}>
        <Note tone="text">{t('pairing.checkBody', { server: unchecked.serverUrl })}</Note>
        <Text
          testID="pairing-fingerprint"
          selectable
          style={[
            styles.fingerprint,
            { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          {formatFingerprint(unchecked.authority.sha256)}
        </Text>
        <Button
          testID="pairing-confirm"
          size="lg"
          fullWidth
          onPress={() => {
            setUnchecked(undefined);
            run(() => session.pair(unchecked.serverUrl, code, unchecked.authority));
          }}
        >
          {t('pairing.checkConfirm')}
        </Button>
        <Button
          testID="pairing-check-cancel"
          variant="secondary"
          fullWidth
          onPress={() => {
            setUnchecked(undefined);
          }}
        >
          {t('pairing.checkCancel')}
        </Button>
      </Screen>
    );
  }

  if (scanning) {
    return (
      <Screen title={t('pairing.scanTitle')}>
        <Suspense fallback={<Note>{t('pairing.cameraStarting')}</Note>}>
          <QrScanner
            onScanned={scanned}
            onCancel={() => {
              setScanning(false);
            }}
          />
        </Suspense>
      </Screen>
    );
  }

  return (
    <Screen title={t('pairing.title')}>
      {notice === 'revoked' && <Note tone="danger">{t('pairing.revoked')}</Note>}
      <Note>{t('pairing.scanIntro')}</Note>
      <Button
        testID="pairing-scan"
        variant="secondary"
        size="lg"
        fullWidth
        disabled={working}
        onPress={() => {
          setError(null);
          setScanning(true);
        }}
      >
        {t('pairing.scan')}
      </Button>
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
      {hint !== null && (
        <Note tone="text" testID="pairing-hint">
          {hint}
        </Note>
      )}
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
        onPress={submit}
      >
        {working ? t('pairing.working') : t('pairing.submit')}
      </Button>
    </Screen>
  );
}

const styles = StyleSheet.create({
  fingerprint: {
    fontFamily: 'monospace',
    fontSize: fontSize.md,
    lineHeight: fontSize.md * 1.6,
    padding: spacing[3],
    borderWidth: 1,
    borderRadius: radius.md,
  },
});
