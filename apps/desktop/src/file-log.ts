import {
  appendFileSync,
  closeSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** The log is renamed to `<file>.1` at this size, so it never fills the disk. */
const MAX_BYTES = 1024 * 1024;

export interface FileLogDeps {
  readonly now?: () => Date;
  readonly write?: (file: string, text: string) => void;
}

/**
 * The shell's events in a file (DESKTOP-R2): a refused navigation, certificate or permission, a
 * crash, a reopened window. A window app has no console, so without this they would be lost. The
 * diagnostics bundle reads the folder. Never throws: a log that cannot be written must not stop
 * the POS.
 */
export function fileLog(
  file: string | undefined,
  deps: FileLogDeps = {},
): (message: string) => void {
  const now = deps.now ?? (() => new Date());
  const write =
    deps.write ??
    ((path: string, text: string) => {
      mkdirSync(dirname(path), { recursive: true });
      // The size is read from the open file and the rotation goes through it too, so the file is
      // never looked up by name between the check and the write (CWE-367): its contents become
      // `<file>.1` and it starts again empty.
      const fd = openSync(path, 'a+');
      try {
        if (fstatSync(fd).size > MAX_BYTES) {
          writeFileSync(`${path}.1`, readFileSync(fd));
          ftruncateSync(fd, 0);
        }
        appendFileSync(fd, text);
      } finally {
        closeSync(fd);
      }
    });
  return (message) => {
    // One line per event, whatever the message holds.
    const line = `${now().toISOString()} ${message.replace(/[\r\n]+/g, ' ')}\n`;
    if (file === undefined) return;
    try {
      write(file, line);
    } catch {
      // Nothing more to do.
    }
  };
}
