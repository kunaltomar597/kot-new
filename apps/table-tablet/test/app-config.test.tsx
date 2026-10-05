import { CLIENT_API_VERSION } from '@rp/contracts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';
import appConfig, { clientApiVersion } from '../app.config';

const projectRoot = join(__dirname, '..');
const variables = process.env as Record<string, string | undefined>;

function configFor(env: Record<string, string | undefined>): ExpoConfig {
  const saved = { APP_ENV: variables.APP_ENV, EAS_PROJECT_ID: variables.EAS_PROJECT_ID };
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) Reflect.deleteProperty(variables, key);
      else variables[key] = value;
    }
  };
  apply(env);
  try {
    return appConfig({ config: {}, projectRoot } as unknown as ConfigContext);
  } finally {
    apply(saved);
  }
}

describe('[UPD-001] [UPD-007] the app’s over-the-air updates', () => {
  it('publishes each update with the client API its JavaScript speaks', () => {
    expect(clientApiVersion(projectRoot)).toBe(CLIENT_API_VERSION);
    expect(configFor({ APP_ENV: 'development' }).extra?.clientApi).toBe(CLIENT_API_VERSION);
  });

  it('is off without an EAS project', () => {
    expect(configFor({ APP_ENV: 'production', EAS_PROJECT_ID: undefined }).updates).toEqual({
      enabled: false,
    });
  });

  it('never looks for an update by itself: the app asks its server first', () => {
    const updates = configFor({ APP_ENV: 'development', EAS_PROJECT_ID: 'project-1' }).updates;
    expect(updates).toMatchObject({
      url: 'https://u.expo.dev/project-1',
      checkAutomatically: 'NEVER',
    });
  });

  it('takes only updates signed with the owner’s key in preview and production builds', () => {
    // The certificate is committed once the Business Owner has generated it (the README).
    if (existsSync(join(projectRoot, 'certs', 'update-signing-certificate.pem'))) {
      expect(
        configFor({ APP_ENV: 'production', EAS_PROJECT_ID: 'project-1' }).updates,
      ).toMatchObject({
        codeSigningCertificate: './certs/update-signing-certificate.pem',
        codeSigningMetadata: { keyid: 'main', alg: 'rsa-v1_5-sha256' },
      });
    } else {
      expect(() => configFor({ APP_ENV: 'production', EAS_PROJECT_ID: 'project-1' })).toThrow(
        /update-signing-certificate\.pem/,
      );
      expect(() => configFor({ APP_ENV: 'preview', EAS_PROJECT_ID: 'project-1' })).toThrow(
        /UPD-007/,
      );
    }
  });
});
