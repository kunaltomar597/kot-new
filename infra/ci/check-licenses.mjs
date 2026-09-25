#!/usr/bin/env node
// Licence check for production dependencies (NFR-M07, SEC-013). Reads `pnpm licenses list --prod`
// for the whole workspace and fails when a package's licence is not allowed by
// infra/ci/license-policy.json. Licence expressions are SPDX: `A OR B` passes when either side is
// allowed, `A AND B` only when both are.
//
// Usage: pnpm licenses:check
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Splits an SPDX expression into tokens: identifiers, AND, OR, parentheses. */
function tokenize(expression) {
  return expression
    .replace(/[()]/g, ' $& ')
    .split(/\s+/)
    .filter(Boolean)
    .reduce((tokens, token) => {
      // `X WITH exception` is one licence identifier.
      const previous = tokens.at(-1);
      if (previous?.endsWith(' WITH')) tokens[tokens.length - 1] = `${previous} ${token}`;
      else if (token === 'WITH' && previous !== undefined) tokens[tokens.length - 1] += ' WITH';
      else tokens.push(token);
      return tokens;
    }, []);
}

/** Evaluates an SPDX expression; `accept(id)` decides single identifiers. */
export function satisfies(expression, accept) {
  const tokens = tokenize(expression);
  let position = 0;
  const primary = () => {
    const token = tokens[position++];
    if (token === '(') {
      const value = or();
      position++; // ')'
      return value;
    }
    return token !== undefined && accept(token);
  };
  const and = () => {
    let value = primary();
    while (tokens[position]?.toUpperCase() === 'AND') {
      position++;
      value = primary() && value;
    }
    return value;
  };
  const or = () => {
    let value = and();
    while (tokens[position]?.toUpperCase() === 'OR') {
      position++;
      value = and() || value;
    }
    return value;
  };
  return or();
}

/**
 * Returns one message per package that violates the policy.
 * `report` is the JSON printed by `pnpm licenses list --json`.
 */
export function findViolations(report, policy) {
  const allowed = new Set(policy.allowed);
  const blocked = policy.blocked.map((pattern) => new RegExp(pattern, 'i'));
  const isBlocked = (id) => blocked.some((pattern) => pattern.test(id));
  const violations = [];
  for (const [license, packages] of Object.entries(report)) {
    for (const pkg of packages) {
      const label = `${pkg.name}@${pkg.versions.join(', ')} (${license})`;
      if (satisfies(license, (id) => allowed.has(id))) continue;
      if (satisfies(license, isBlocked)) {
        violations.push(`${label}: blocked licence, incompatible with commercial distribution`);
      } else if (policy.exceptions[pkg.name]?.reason) {
        continue;
      } else {
        violations.push(`${label}: licence not on the allow-list`);
      }
    }
  }
  return violations.sort();
}

function main() {
  const policyPath = fileURLToPath(new URL('./license-policy.json', import.meta.url));
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  const output = execFileSync('pnpm', ['licenses', 'list', '--prod', '--recursive', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // pnpm prints nothing parseable when there are no production dependencies.
  const report = output.trim().startsWith('{') ? JSON.parse(output) : {};
  const count = Object.values(report).reduce((sum, packages) => sum + packages.length, 0);
  const violations = findViolations(report, policy);
  if (violations.length > 0) {
    process.stderr.write(
      `Licence check failed for ${violations.length} production dependenc${violations.length === 1 ? 'y' : 'ies'}:\n` +
        violations.map((line) => `  ${line}\n`).join('') +
        'Replace the dependency, or add a reviewed exception with a reason to infra/ci/license-policy.json.\n',
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(`Licence check passed for ${count} production dependencies.\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
