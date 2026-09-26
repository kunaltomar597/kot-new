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
    expect(loadConfig({ CP_ENV: 'production', DATABASE_URL: MANAGED }).env).toBe('production');
    expect(databaseUsesTls('not a url')).toBe(false);
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
