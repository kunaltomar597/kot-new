import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * The table tablet's native configuration per environment (P2-01c). `APP_ENV` comes from the EAS
 * build profile (`eas.json`) or the shell: `development` (default), `preview` or `production`.
 * Each environment is its own Android package, so a test build never replaces the real app.
 *
 * Kiosk lock-task mode is set by MDM as device owner (P3-01); the app itself asks for nothing extra.
 *
 * Nothing secret lives here (SEC-002): the Android signing keystore and the EAS Update code
 * signing private key are EAS secrets. Only the update signing certificate (public) is committed,
 * once the Business Owner has generated it (see the README).
 */
const ENVIRONMENTS = {
  development: { suffix: '.dev', label: ' (dev)' },
  preview: { suffix: '.preview', label: ' (preview)' },
  production: { suffix: '', label: '' },
} as const;

type AppEnv = keyof typeof ENVIRONMENTS;

// React Native's globals type `process.env` loosely; the config runs in Node, where it is strings.
const variables = process.env as Record<string, string | undefined>;

function appEnv(): AppEnv {
  const value = variables.APP_ENV ?? 'development';
  if (!(value in ENVIRONMENTS)) {
    throw new Error(`APP_ENV must be development, preview or production, not "${value}".`);
  }
  return value as AppEnv;
}

const UPDATE_CERTIFICATE = './certs/update-signing-certificate.pem';

export default ({ config, projectRoot }: ConfigContext): ExpoConfig => {
  const env = appEnv();
  const { suffix, label } = ENVIRONMENTS[env];
  const projectId = variables.EAS_PROJECT_ID;
  const signed = existsSync(join(projectRoot, UPDATE_CERTIFICATE));
  return {
    ...config,
    name: `RP Table${label}`,
    slug: 'rp-table-tablet',
    version: '0.1.0',
    orientation: 'landscape',
    icon: './assets/icon.png',
    userInterfaceStyle: 'light',
    runtimeVersion: { policy: 'appVersion' },
    android: {
      package: `in.rp.tablet${suffix}`,
      adaptiveIcon: {
        backgroundColor: '#E6F4FE',
        foregroundImage: './assets/android-icon-foreground.png',
        backgroundImage: './assets/android-icon-background.png',
        monochromeImage: './assets/android-icon-monochrome.png',
      },
      // The app needs the network, and the camera only to scan the pairing QR code; no location,
      // contacts, microphone or media (SEC-002 least privilege).
      blockedPermissions: [
        'android.permission.RECORD_AUDIO',
        'android.permission.SYSTEM_ALERT_WINDOW',
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
      ],
    },
    updates:
      projectId === undefined
        ? { enabled: false }
        : {
            url: `https://u.expo.dev/${projectId}`,
            // Updates are only accepted when signed with the owner's key (SEC-014).
            ...(signed && {
              codeSigningCertificate: UPDATE_CERTIFICATE,
              codeSigningMetadata: { keyid: 'main', alg: 'rsa-v1_5-sha256' },
            }),
          },
    extra: {
      appEnv: env,
      ...(projectId !== undefined && { eas: { projectId } }),
    },
    plugins: [
      [
        'expo-build-properties',
        {
          android: {
            minSdkVersion: 26,
            // Development servers run without TLS; preview and production builds refuse
            // cleartext, so they only talk to the server over TLS (SEC-001, ADR-0011).
            usesCleartextTraffic: env === 'development',
          },
        },
      ],
      'expo-secure-store',
      // Scanning the pairing QR code (P2-01d): the camera without the microphone.
      ['expo-camera', { recordAudioAndroid: false }],
    ],
  };
};
