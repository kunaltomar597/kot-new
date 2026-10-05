import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * The waiter app's native configuration per environment (P2-01c). `APP_ENV` comes from the EAS
 * build profile (`eas.json`) or the shell: `development` (default), `preview` or `production`.
 * Each environment is its own Android package, so a test build never replaces the real app.
 *
 * Nothing secret lives here (SEC-002): the Android signing keystore and the EAS Update code
 * signing private key are EAS secrets. Only the update signing certificate (public) is committed,
 * once the Business Owner has generated it (see the README). A preview or production build with
 * EAS Update refuses to build without it, so it never takes an unsigned update (UPD-007).
 *
 * The app never looks for an update by itself (`checkAutomatically: NEVER`): `@rp/mobile-core`'s
 * `OtaUpdater` first asks the restaurant's server which client API it speaks, and takes an update
 * only when the server speaks the update's (P7-04e1). Each update carries its client API in
 * `extra.clientApi`, which EAS keeps in its manifest.
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

/**
 * The client API this JavaScript speaks: `CLIENT_API_VERSION` in `@rp/contracts`, read from its
 * source because the config is evaluated before any package is built.
 */
export function clientApiVersion(projectRoot: string): string {
  const source = readFileSync(
    join(projectRoot, '..', '..', 'packages', 'contracts', 'src', 'client-api.ts'),
    'utf8',
  );
  const match = /^export const CLIENT_API_VERSION = '(\d+\.\d+)';$/m.exec(source);
  if (match?.[1] === undefined) throw new Error('CLIENT_API_VERSION not found in @rp/contracts.');
  return match[1];
}

function packageVersion(projectRoot: string): string {
  const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

export default ({ config, projectRoot }: ConfigContext): ExpoConfig => {
  const env = appEnv();
  const { suffix, label } = ENVIRONMENTS[env];
  const projectId = variables.EAS_PROJECT_ID;
  const signed = existsSync(join(projectRoot, UPDATE_CERTIFICATE));
  if (projectId !== undefined && env !== 'development' && !signed) {
    throw new Error(
      `A ${env} build with EAS Update needs ${UPDATE_CERTIFICATE} (UPD-007): generate it as the README says.`,
    );
  }
  return {
    ...config,
    name: `RP Waiter${label}`,
    slug: 'rp-waiter',
    // The release pipeline sets package.json; the version matrix reads it there too (UPD-006).
    version: packageVersion(projectRoot),
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'light',
    runtimeVersion: { policy: 'appVersion' },
    android: {
      package: `in.rp.waiter${suffix}`,
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
            // The OtaUpdater checks, after asking the restaurant's server (P7-04e1).
            checkAutomatically: 'NEVER',
            // Updates are only accepted when signed with the owner's key (SEC-014).
            ...(signed && {
              codeSigningCertificate: UPDATE_CERTIFICATE,
              codeSigningMetadata: { keyid: 'main', alg: 'rsa-v1_5-sha256' },
            }),
          },
    extra: {
      appEnv: env,
      clientApi: clientApiVersion(projectRoot),
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
