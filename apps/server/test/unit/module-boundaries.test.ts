import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(import.meta.dirname, '..', '..', 'src');

// BRD INT-001: Core POS (menu, tables, orders, billing) is its own module. INT-003: the
// peripheral modules (pager, notifications, QR relay, recommendations) depend on the core through
// ports; the core never reaches into them.
const CORE = ['orders', 'billing', 'menu', 'floor', 'payments', 'day-end'];
const PERIPHERAL = ['pagers', 'pager-firmware', 'recommendations', 'relay', 'service-requests'];

function* files(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (path.endsWith('.ts')) yield path;
  }
}

function importsOf(module: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of files(join(src, module))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/from '\.\.\/([a-z-]+)\//g)) {
      const target = match[1]!;
      found.set(target, [...(found.get(target) ?? []), file.slice(src.length + 1)]);
    }
  }
  return found;
}

describe('[INT-001] [INT-003] module boundaries', () => {
  it('[INT-001] keeps every core module in its own folder', () => {
    for (const module of CORE) expect(statSync(join(src, module)).isDirectory()).toBe(true);
  });

  it('[INT-003] never lets the core import a peripheral module', () => {
    const violations: string[] = [];
    for (const module of CORE) {
      for (const [target, from] of importsOf(module)) {
        if (PERIPHERAL.includes(target)) violations.push(`${module} -> ${target} (${from[0]})`);
      }
    }
    expect(violations).toEqual([]);
  });
});
