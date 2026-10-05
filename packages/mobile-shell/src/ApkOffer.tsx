import { spacing } from '@rp/design-tokens';
import type { ApkSnapshot } from '@rp/mobile-core';
import { Button } from '@rp/ui-native';
import { StyleSheet, View } from 'react-native';
import { useApkUpdate, useApkUpdater, useT } from './context.js';
import { Note } from './Screen.js';

/** An APK's size in whole megabytes, at least 1. */
export function megabytesOf(sizeBytes: number): number {
  return Math.max(1, Math.round(sizeBytes / 1_000_000));
}

const ignore = () => undefined;

/**
 * A new version of this app on the restaurant PC (P7-04e2, WTR-001): what it is, and Install.
 * Android then asks the person to confirm; where it does not let the app install yet, the person
 * is sent to Android's setting first. Shown on the sign-in screen, on "Update this app" and on a
 * tablet's staff panel; nothing while the app is up to date.
 */
export function ApkOffer() {
  const updater = useApkUpdater();
  const update = useApkUpdate();
  const t = useT();
  const build = update?.build ?? null;
  if (updater === undefined || update === undefined || build === null) return null;
  const { status, failure } = update;
  const install = () => {
    updater.install().catch(ignore);
  };
  const installButton = (label: string) => (
    <Button testID="apk-install" onPress={install}>
      {label}
    </Button>
  );
  let text: string;
  let tone: 'text' | 'danger' = 'text';
  let actions = null;
  switch (status) {
    case 'available':
      text = t('mobile.apk.available', {
        version: build.version,
        megabytes: megabytesOf(build.sizeBytes),
      });
      actions = installButton(t('mobile.apk.install'));
      break;
    case 'needsPermission':
      text = t('mobile.apk.needsPermission');
      actions = (
        <>
          <Button
            testID="apk-settings"
            variant="secondary"
            onPress={() => {
              updater.openInstallSettings().catch(ignore);
            }}
          >
            {t('mobile.apk.openSettings')}
          </Button>
          {installButton(t('mobile.apk.install'))}
        </>
      );
      break;
    case 'downloading':
      text = t('mobile.apk.downloading');
      break;
    case 'installing':
      text = t(updater.silent ? 'mobile.apk.installingSilent' : 'mobile.apk.installing');
      break;
    case 'failed':
      text = t(`mobile.apk.failed.${failure ?? 'download'}`);
      tone = 'danger';
      actions = installButton(t('mobile.apk.tryAgain'));
      break;
    default:
      return null;
  }
  return (
    <View testID="apk-offer" style={styles.offer}>
      <Note tone={tone} testID="apk-offer-text">
        {text}
      </Note>
      {actions}
    </View>
  );
}

/** Whether a new version from the PC is on offer (for screens that word themselves around it). */
export function apkOffered(update: ApkSnapshot | undefined): boolean {
  return (
    update !== undefined &&
    update.build !== null &&
    update.status !== 'idle' &&
    update.status !== 'off'
  );
}

const styles = StyleSheet.create({
  offer: { gap: spacing[2], marginBottom: spacing[3] },
});
