/**
 * Whether the server's program files are the ones the release shipped (LIC-007, LICENCE-T5). The
 * release lists every file with its SHA-256; the PC lists what it finds. A difference is reported
 * to the Control Plane as `CODE_MODIFIED`. This is detection, not prevention: whoever administers
 * the PC can also edit the check, so it raises the cost of patching the licence checks and tells
 * the vendor about the careless attempts.
 */

/** File path (forward slashes, relative to the server folder) to its SHA-256 in hex. */
export type FileDigests = Readonly<Record<string, string>>;

export interface IntegrityManifest {
  readonly format: 1;
  readonly files: FileDigests;
}

export type IntegrityVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly changed: readonly string[];
      readonly missing: readonly string[];
      readonly added: readonly string[];
    };

/** Compares what the release listed with what the PC holds; paths come back sorted. */
export function judgeIntegrity(manifest: IntegrityManifest, found: FileDigests): IntegrityVerdict {
  const changed: string[] = [];
  const missing: string[] = [];
  for (const [path, digest] of Object.entries(manifest.files)) {
    const now = found[path];
    if (now === undefined) missing.push(path);
    else if (now !== digest) changed.push(path);
  }
  const added = Object.keys(found).filter((path) => manifest.files[path] === undefined);
  if (changed.length + missing.length + added.length === 0) return { ok: true };
  return { ok: false, changed: changed.sort(), missing: missing.sort(), added: added.sort() };
}
