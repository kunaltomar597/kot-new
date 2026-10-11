import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { scrubText } from '@rp/domain';

/** At most this many log files, newest first, and this much of the end of each. */
const MAX_FILES = 3;
const MAX_BYTES_PER_FILE = 1024 * 1024;
const MAX_LINES_PER_FILE = 2_000;

export interface LogTail {
  readonly files: { readonly name: string; readonly lines: string[] }[];
  readonly truncated: boolean;
}

/**
 * The end of the newest log files in `directory` (the Windows service writes the server's logs
 * there, P0-16), every line scrubbed of secrets and personal data (UPD-008, SEC-015). A missing
 * folder is no logs, not an error.
 */
export async function readLogTail(directory: string): Promise<LogTail> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => /\.(log|txt|out|err)$/i.test(name));
  } catch {
    return { files: [], truncated: false };
  }
  const withTimes = await Promise.all(
    names.map(async (name) => ({ name, modified: (await stat(join(directory, name))).mtimeMs })),
  );
  withTimes.sort((a, b) => b.modified - a.modified);
  let truncated = withTimes.length > MAX_FILES;
  const files: LogTail['files'] = [];
  for (const { name } of withTimes.slice(0, MAX_FILES)) {
    const handle = await open(join(directory, name), 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - MAX_BYTES_PER_FILE);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      // Scrubbed whole, so a secret spread over lines (a PEM key, say) is caught too.
      let lines = scrubText(buffer.toString('utf8')).split(/\r?\n/);
      // A read that starts mid-file starts mid-line: drop the partial first line.
      if (start > 0) lines = lines.slice(1);
      if (lines.at(-1) === '') lines.pop();
      if (start > 0 || lines.length > MAX_LINES_PER_FILE) truncated = true;
      files.push({ name, lines: lines.slice(-MAX_LINES_PER_FILE) });
    } finally {
      await handle.close();
    }
  }
  return { files, truncated };
}
