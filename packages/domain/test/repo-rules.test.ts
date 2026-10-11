import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

describe('rules the repository enforces on itself', () => {
  it('[NFR-M02] keeps the domain package free of frameworks', () => {
    const manifest = JSON.parse(read('packages/domain/package.json')) as {
      dependencies?: Record<string, string>;
    };
    const banned = /^(@nestjs|react|express|@prisma|prisma|socket\.io|mqtt|pg)/;
    expect(Object.keys(manifest.dependencies ?? {}).filter((name) => banned.test(name))).toEqual(
      [],
    );
    const source = join(root, 'packages', 'domain', 'src');
    for (const file of readdirSync(source, { recursive: true, encoding: 'utf8' })) {
      if (!file.endsWith('.ts')) continue;
      const text = readFileSync(join(source, file), 'utf8');
      expect(text, file).not.toMatch(/from '(@nestjs|react|express|@prisma|socket\.io|mqtt)/);
    }
  });

  it('[NFR-M03] compiles in strict mode and refuses explicit any', () => {
    expect(read('tsconfig.base.json')).toMatch(/"strict":\s*true/);
    expect(read('eslint.config.mjs')).toMatch(/no-explicit-any'?:\s*'error'/);
  });

  it('[NFR-M04] fails the build under 85 % domain and 70 % backend line coverage', () => {
    expect(read('packages/domain/vitest.config.ts')).toMatch(/thresholds:\s*{\s*lines:\s*85/);
    expect(read('apps/server/vitest.config.ts')).toMatch(/thresholds:\s*{\s*lines:\s*70/);
  });

  it('[NFR-L01] ships one UI catalogue, English', () => {
    expect(readdirSync(join(root, 'packages', 'i18n', 'src', 'catalogues'))).toEqual(['en.ts']);
  });

  it('[SEC-016] has an incident response plan with severity levels, contacts and CERT-In', () => {
    const plan = read('docs/security/incident-response.md');
    for (const heading of ['## Who is who', '## Severity levels', '## Reporting to CERT-In']) {
      expect(plan).toContain(heading);
    }
  });
});
