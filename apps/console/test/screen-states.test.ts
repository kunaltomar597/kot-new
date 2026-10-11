// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P8-04a audit guard (NFR-U04): a screen folder that shows a loading state also has a designed
 * error state, and one that lists records also has a designed empty state. The audit itself is
 * docs/usability/ux-audit.md.
 */

const src = new URL('../src/', import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.tsx') ? [path] : [];
  });
}

/** Folders that hold screens: each folder of manage/, plus the other top-level screen folders. */
const folders = [
  ...readdirSync(join(src, 'manage'))
    .map((name) => join(src, 'manage', name))
    .filter((path) => statSync(path).isDirectory()),
  ...['pos', 'kds', 'billing', 'alerts', 'owner', 'screens'].map((name) => join(src, name)),
];

const text = (dir: string) =>
  files(dir)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');

describe('[NFR-U04] every screen folder has designed states', () => {
  it.each(folders.map((dir) => [dir.slice(src.length), dir] as const))(
    '%s: a loading state comes with an error state',
    (_name, dir) => {
      const all = text(dir);
      if (/Spinner|Skeleton|oading/.test(all)) expect(all).toMatch(/ErrorState|role="alert"/);
    },
  );

  it.each(folders.map((dir) => [dir.slice(src.length), dir] as const))(
    '%s: a list comes with an empty state',
    (_name, dir) => {
      const all = text(dir);
      // Folders listed here show a fixed set of rows or a form, never a list that can be empty.
      const fixed = [
        'manage/audit',
        'manage/licence',
        'manage/reports',
        'manage/setup',
        'manage/system',
        'owner',
      ];
      if (fixed.some((name) => dir.endsWith(name))) return;
      if (/<ul|<table|\.map\(/.test(all)) expect(all).toMatch(/EmptyState|empty/i);
    },
  );
});
