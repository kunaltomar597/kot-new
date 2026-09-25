import { describe, expect, it } from 'vitest';
import { ConfigError, isLoopbackDatabaseUrl, loadConfig } from '../../src/config/app-config.js';

const base = { DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/rp' };

describe('server configuration', () => {
  it('applies defaults', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      nodeEnv: 'development',
      host: '0.0.0.0',
      port: 8080,
      dataDir: './.data',
      logLevel: 'info',
      logPretty: false,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('reads and coerces environment variables', () => {
    const config = loadConfig({
      ...base,
      NODE_ENV: 'production',
      PORT: '9443',
      LOG_LEVEL: 'warn',
      LOG_PRETTY: '1',
      RP_DATA_DIR: 'D:\\RestaurantData',
      RP_BUILD_ID: 'abc123',
    });
    expect(config).toMatchObject({
      nodeEnv: 'production',
      port: 9443,
      logLevel: 'warn',
      logPretty: true,
      dataDir: 'D:\\RestaurantData',
      buildId: 'abc123',
    });
  });

  it('rejects invalid values with a readable message', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x' })).toThrow(/postgresql/);
    expect(() => loadConfig({ ...base, PORT: '70000' })).toThrow(/port/);
    expect(() => loadConfig({ ...base, LOG_LEVEL: 'loud' })).toThrow(/logLevel/);
  });

  it('[DATA-001] requires a local database in production', () => {
    expect(isLoopbackDatabaseUrl('postgresql://u@localhost/x')).toBe(true);
    expect(isLoopbackDatabaseUrl('postgresql://u@[::1]:5432/x')).toBe(true);
    expect(isLoopbackDatabaseUrl('postgresql://u@db.example.com/x')).toBe(false);
    expect(isLoopbackDatabaseUrl('not a url')).toBe(false);
    expect(() =>
      loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://u@10.0.0.5/rp' }),
    ).toThrow(/localhost/);
    expect(() =>
      loadConfig({ NODE_ENV: 'development', DATABASE_URL: 'postgresql://u@10.0.0.5/rp' }),
    ).not.toThrow();
  });
});
