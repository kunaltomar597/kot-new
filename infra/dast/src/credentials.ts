import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Headers ZAP adds to every request whose URL matches `url` (a JavaScript regular expression). */
export interface HeaderRule {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * ZAP's request script (an `httpsender` in Graal.js): before each request it adds the headers of
 * the rules in `headers.json` whose pattern matches the URL. The file is read again whenever it
 * changed, so the run can renew a session (the local server's access tokens last 15 minutes)
 * while ZAP keeps scanning. `folder` is the run's folder as ZAP sees it.
 */
export function headerScript(folder: string): string {
  return `// Written by @rp/dast (P8-03c1): the run's credentials on every request.
var Files = Java.type('java.nio.file.Files');
var Paths = Java.type('java.nio.file.Paths');
var JString = Java.type('java.lang.String');
var FILE = Paths.get(${JSON.stringify(`${folder}/headers.json`)});
var loadedAt = -1;
var rules = [];

function currentRules() {
  var modified = Files.getLastModifiedTime(FILE).toMillis();
  if (modified !== loadedAt) {
    var text = String(new JString(Files.readAllBytes(FILE), 'UTF-8'));
    rules = JSON.parse(text).rules.map(function (rule) {
      return { url: new RegExp(rule.url), headers: rule.headers };
    });
    loadedAt = modified;
  }
  return rules;
}

function sendingRequest(msg, initiator, helper) {
  var header = msg.getRequestHeader();
  var url = String(header.getURI().toString());
  currentRules().forEach(function (rule) {
    if (rule.url.test(url)) {
      Object.keys(rule.headers).forEach(function (name) {
        header.setHeader(name, rule.headers[name]);
      });
    }
  });
}

function responseReceived(msg, initiator, helper) {}
`;
}

/** Writes the rules ZAP's script reads, whole: ZAP never reads half a file. */
export function writeHeaderRules(folder: string, rules: readonly HeaderRule[]): void {
  const file = join(folder, 'headers.json');
  writeFileSync(`${file}.tmp`, JSON.stringify({ rules }));
  renameSync(`${file}.tmp`, file);
}

/** `text` as a regular expression matching it literally (in JavaScript and in Java). */
export function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A regular expression for every URL under `origin` and `path`. */
export function urlsUnder(origin: string, path = '/'): string {
  return `^${escaped(origin + path)}`;
}
