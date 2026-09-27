import { radius, spacing } from '@rp/design-tokens';
import { Button } from '@rp/ui-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useT } from './context.js';
import { Note } from './Screen.js';

/**
 * The camera reading the manager's pairing QR code (AUTH-007). It looks for QR codes only and hands
 * on the first one it reads, once. The pairing screen loads it only when a person chooses to scan,
 * so no other screen needs the camera module.
 */
export function QrScanner({
  onScanned,
  onCancel,
}: {
  onScanned: (data: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [permission, requestPermission] = useCameraPermissions({ request: true });
  // A table tablet on its stand may only have a camera facing the guests.
  const [facing, setFacing] = useState<'back' | 'front'>('back');
  const read = useRef(false);

  return (
    <View style={styles.scanner}>
      <Note tone="text">{t('pairing.scanHint')}</Note>
      {permission === null ? <Note>{t('pairing.cameraStarting')}</Note> : null}
      {permission !== null && !permission.granted ? (
        <>
          <Note tone="danger" testID="pairing-camera-denied">
            {t('pairing.cameraDenied')}
          </Note>
          {permission.canAskAgain ? (
            <Button
              variant="secondary"
              fullWidth
              onPress={() => {
                void requestPermission();
              }}
            >
              {t('pairing.allowCamera')}
            </Button>
          ) : null}
        </>
      ) : null}
      {permission?.granted === true ? (
        <>
          <CameraView
            testID="pairing-camera"
            style={styles.camera}
            facing={facing}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              if (read.current) return;
              read.current = true;
              onScanned(data);
            }}
          />
          <Button
            variant="secondary"
            fullWidth
            onPress={() => {
              setFacing(facing === 'back' ? 'front' : 'back');
            }}
          >
            {t('pairing.switchCamera')}
          </Button>
        </>
      ) : null}
      <Button variant="ghost" fullWidth testID="pairing-type-instead" onPress={onCancel}>
        {t('pairing.typeInstead')}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  scanner: { gap: spacing[3] },
  camera: { width: '100%', aspectRatio: 1, borderRadius: radius.lg, overflow: 'hidden' },
});
