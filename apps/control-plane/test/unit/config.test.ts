import { describe, expect, it } from 'vitest';
import { ConfigError, databaseUsesTls, loadConfig } from '../../src/config/cp-config.js';

const LOCAL = 'postgresql://postgres@127.0.0.1:5432/cp_dev';
const MANAGED = 'postgresql://cp:x@db.ap-south-1.example.com:5432/cp?sslmode=verify-full';

describe('[VCP-009] [SEC-002] Control Plane configuration', () => {
  it('reads development defaults from the environment', () => {
    const config = loadConfig({ DATABASE_URL: LOCAL });
    expect(config).toMatchObject({ env: 'development', port: 8090, heartbeatSeconds: 300 });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('[SEC-001] needs TLS to the database in staging and production', () => {
    expect(() => loadConfig({ CP_ENV: 'production', DATABASE_URL: LOCAL })).toThrow(ConfigError);
    expect(() =>
      loadConfig({ CP_ENV: 'staging', DATABASE_URL: `${LOCAL}?sslmode=prefer` }),
    ).toThrow(/sslmode=require/);
    const SECRET = Buffer.alloc(32, 1).toString('base64');
    expect(
      loadConfig({ CP_ENV: 'production', DATABASE_URL: MANAGED, CP_SECRET_KEY: SECRET }).env,
    ).toBe('production');
    expect(databaseUsesTls('not a url')).toBe(false);
  });

  it('[VCP-001] needs its own secret key in staging and production', () => {
    expect(() => loadConfig({ CP_ENV: 'production', DATABASE_URL: MANAGED })).toThrow(
      /CP_SECRET_KEY/,
    );
    expect(() =>
      loadConfig({ CP_ENV: 'staging', DATABASE_URL: MANAGED, CP_SECRET_KEY: 'c2hvcnQ=' }),
    ).toThrow(ConfigError);
    expect(loadConfig({ DATABASE_URL: LOCAL }).secretKey).toBeUndefined();
  });

  it('[SEC-001] reaches every outside service over https in staging and production', () => {
    const production = {
      CP_ENV: 'production',
      DATABASE_URL: MANAGED,
      CP_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
    };
    const services = [
      ['CP_AI_BASE_URL', 'http://ai.example.com'],
      ['CP_WHATSAPP_API_URL', 'http://graph.example.com/v21.0'],
      ['CP_ERROR_DSN', 'http://public@errors.example.com/7'],
      ['CP_ALERT_WEBHOOK_URL', 'http://hooks.example.com/alerts'],
      ['CP_PUBLIC_URL', 'http://cloud.example.in'],
      ['CP_BACKUP_S3_ENDPOINT', 'http://s3.example.com'],
      ['CP_ESCROW_KMS_ENDPOINT', 'http://kms.example.com'],
    ] as const;
    for (const [variable, url] of services) {
      expect(() => loadConfig({ ...production, [variable]: url })).toThrow(
        `need an https:// ${variable}`,
      );
      expect(() => loadConfig({ ...production, CP_ENV: 'staging', [variable]: url })).toThrow(
        ConfigError,
      );
      const secure = url.replace('http://', 'https://');
      expect(loadConfig({ ...production, [variable]: secure }).env).toBe('production');
      // A developer's own machine may use plain http.
      expect(loadConfig({ DATABASE_URL: LOCAL, [variable]: url }).env).toBe('development');
    }
  });

  it('names wrong settings without echoing their values', () => {
    try {
      loadConfig({ DATABASE_URL: LOCAL, CP_HEARTBEAT_SECONDS: '5', PORT: 'secret-looking' });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toMatch(/heartbeatSeconds/);
      expect(String(error)).not.toMatch(/secret-looking/);
    }
    expect(() => loadConfig({})).toThrow(/databaseUrl/);
  });
});
