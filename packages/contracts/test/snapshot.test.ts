import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import { describe, expect, it } from 'vitest';
import * as controlPlane from '../src/control-plane/index.js';
import * as contracts from '../src/index.js';
import { collectSchemas, toStandaloneJsonSchema } from '../scripts/lib/schema-catalog.js';

/**
 * JSON-schema snapshot of every exported contract schema (INT-002, UPD-006). A change to a
 * contract changes its file under test/__snapshots__/schemas/, so the change is visible in review
 * and a reviewer can judge whether it breaks clients one version behind. New exports are picked up
 * automatically: run the tests locally to write their snapshot and commit it (CI never writes
 * snapshots, so a missing one fails there).
 */

const SNAPSHOT_DIR = fileURLToPath(new URL('./__snapshots__/schemas/', import.meta.url));
const schemas = collectSchemas(contracts);
const shared = new Set(schemas.values());
/** Control Plane schemas (ADR-0012), without the shared ones it re-exports. */
const controlPlaneSchemas = new Map(
  [...collectSchemas(controlPlane)].filter(([, schema]) => !shared.has(schema)),
);

const SETS = [
  { label: 'local', dir: SNAPSHOT_DIR, schemas },
  { label: 'control-plane', dir: `${SNAPSHOT_DIR}control-plane/`, schemas: controlPlaneSchemas },
] as const;

describe('[INT-002] [UPD-006] contract schema snapshots', () => {
  const cases = SETS.flatMap((set) => [...set.schemas.keys()].map((name) => ({ set, name })));
  it.each(cases.map(({ set, name }) => [`${set.label} ${name}`, set, name] as const))(
    '%s matches its committed JSON schema',
    async (_title, set, name) => {
      const schema = set.schemas.get(name)!;
      const snapshot = {
        input: toStandaloneJsonSchema(schema, 'input'),
        output: toStandaloneJsonSchema(schema, 'output'),
      };
      // Formatted like the rest of the repository so `pnpm format:check` accepts the files.
      const file = `${set.dir}${name}.json`;
      const config = await prettier.resolveConfig(file);
      const text = await prettier.format(JSON.stringify(snapshot), { ...config, filepath: file });
      await expect(text).toMatchFileSnapshot(file);
    },
  );

  it.each(SETS.map((set) => [set.label, set] as const))(
    'has no %s snapshot left over from a removed or renamed schema',
    (_label, set) => {
      // Vitest writes new file snapshots after the tests, so the folder may not exist yet.
      if (!existsSync(set.dir)) return;
      const files = readdirSync(set.dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name.slice(0, -'.json'.length));
      const orphans = files.filter((name) => !set.schemas.has(name));
      expect(orphans, `delete these files from ${set.dir}`).toEqual([]);
    },
  );
});
