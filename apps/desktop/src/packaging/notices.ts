import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installedPackages } from './prune.js';

/**
 * The third-party notices shipped with the server (`<install>\server\THIRD-PARTY-NOTICES.txt`,
 * P0-16d): every package in its `node_modules` with its version, licence and licence text, as
 * MIT, BSD and Apache ask. LGPL libvips (sharp) is shipped unmodified as a separate library that
 * can be replaced; its source is named here. Node.js, PostgreSQL and WinSW carry their own licence
 * files beside them; Electron's are beside the POS window.
 */

export interface PackageNotice {
  readonly name: string;
  readonly version: string;
  readonly licence: string;
  readonly text: string | undefined;
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

/** A package's notice, from its package.json and licence files. */
export async function packageNotice(dir: string): Promise<PackageNotice> {
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
    name?: string;
    version?: string;
    license?: string | { type?: string };
    licenses?: { type?: string }[];
  };
  const licence =
    typeof pkg.license === 'string'
      ? pkg.license
      : (pkg.license?.type ?? pkg.licenses?.map((entry) => entry.type).join(' OR ') ?? 'UNKNOWN');
  const files = (await readdir(dir)).filter((name) => LICENCE_FILE.test(name)).sort();
  const texts = await Promise.all(files.map((name) => readFile(join(dir, name), 'utf8')));
  return {
    name: pkg.name ?? dir,
    version: pkg.version ?? '',
    licence: licence === '' ? 'UNKNOWN' : licence,
    text: texts.length > 0 ? texts.map((text) => text.trim()).join('\n\n') : undefined,
  };
}

export function noticesText(notices: readonly PackageNotice[]): string {
  const sorted = [...notices].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name < b.name ? -1 : 1,
  );
  const sections = sorted.map((notice) =>
    [
      `${notice.name} ${notice.version}`,
      `Licence: ${notice.licence}`,
      ...(notice.name.startsWith('@img/sharp-')
        ? [
            'libvips is LGPL-3.0-or-later, shipped unmodified as a separate library that can be',
            'replaced; its source: https://github.com/libvips/libvips and https://github.com/lovell/sharp-libvips',
          ]
        : []),
      '',
      notice.text ?? '(The package carries no licence file; its licence is named above.)',
    ].join('\n'),
  );
  return [
    'Third-party software in the Restaurant Platform server',
    '',
    'The server uses these packages, each under its own licence. Node.js, PostgreSQL and WinSW',
    'carry their licences in their own folders.',
    '',
    ...sections.flatMap((section) => ['='.repeat(78), section, '']),
  ].join('\n');
}

/** The notices of every package installed under `root/node_modules`. */
export async function collectNotices(root: string): Promise<PackageNotice[]> {
  return Promise.all((await installedPackages(join(root, 'node_modules'))).map(packageNotice));
}
