import { SettingsExport } from '@rp/contracts';
import { calendarDateOf } from '@rp/domain';
import type { ServerFile } from '../../app/download.js';

/** The export as a file to keep: `settings-<restaurant>-<date>.json` (ONB-010). */
export function settingsFile(exported: SettingsExport): ServerFile {
  const slug = exported.restaurantName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const date = calendarDateOf(new Date(exported.exportedAt));
  return {
    filename: `settings-${slug === '' ? 'restaurant' : slug}-${date}.json`,
    contentType: 'application/json',
    encoding: 'utf-8',
    content: `${JSON.stringify(exported, null, 2)}\n`,
  };
}

/** A chosen file read back as an export, or `undefined` when it is not one. */
export function parseSettingsFile(text: string): SettingsExport | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = SettingsExport.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}
