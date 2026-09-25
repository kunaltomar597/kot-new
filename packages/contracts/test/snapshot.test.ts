import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import { describe, expect, it } from 'vitest';
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

describe('[INT-002] [UPD-006] contract schema snapshots', () => {
  it.each([...schemas.keys()])('%s matches its committed JSON schema', async (name) => {
    const schema = schemas.get(name)!;
    const snapshot = {
      input: toStandaloneJsonSchema(schema, 'input'),
      output: toStandaloneJsonSchema(schema, 'output'),
    };
    // Formatted like the rest of the repository so `pnpm format:check` accepts the files.
    const file = `${SNAPSHOT_DIR}${name}.json`;
    const config = await prettier.resolveConfig(file);
    const text = await prettier.format(JSON.stringify(snapshot), { ...config, filepath: file });
    await expect(text).toMatchFileSnapshot(file);
  });

  it('has no snapshot left over from a removed or renamed schema', () => {
    // Vitest writes new file snapshots after the tests, so the folder may not exist yet.
    if (!existsSync(SNAPSHOT_DIR)) return;
    const files = readdirSync(SNAPSHOT_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -'.json'.length));
    const orphans = files.filter((name) => !schemas.has(name));
    expect(orphans, 'delete these files from test/__snapshots__/schemas/').toEqual([]);
  });
});
