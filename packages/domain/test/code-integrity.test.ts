import { describe, expect, it } from 'vitest';
import { judgeIntegrity } from '../src/code-integrity.js';

const manifest = { format: 1, files: { 'dist/a.js': 'aa', 'dist/b.js': 'bb' } } as const;

describe('code integrity', () => {
  it('[LIC-007] accepts the files the release shipped', () => {
    expect(judgeIntegrity(manifest, { 'dist/a.js': 'aa', 'dist/b.js': 'bb' })).toEqual({
      ok: true,
    });
  });

  it('[LIC-007] names files that changed, are gone or were added', () => {
    expect(judgeIntegrity(manifest, { 'dist/a.js': 'xx', 'dist/c.js': 'cc' })).toEqual({
      ok: false,
      changed: ['dist/a.js'],
      missing: ['dist/b.js'],
      added: ['dist/c.js'],
    });
  });
});
