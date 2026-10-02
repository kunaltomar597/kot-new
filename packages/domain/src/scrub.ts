/**
 * Scrubbing secrets and personal data from text that leaves the restaurant (UPD-008, NFR-O02,
 * SEC-015): diagnostics bundles and error reports. Pure and pattern-based, applied to every line;
 * what it cannot recognise must never be put in a log in the first place (the logger redacts
 * known fields at the source).
 */

const REDACTED = '[REDACTED]';

/** Field names whose values are secrets, in JSON (`"pin": "1234"`) or text (`password=x`). */
const SECRET_FIELD =
  /("?(?:password|passwd|pass|pwd|secret|token|access_?token|refresh_?token|api_?key|apikey|private_?key|pin|otp|credential|authorization|cookie|set-cookie|dsn|signature)"?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;}&]+)/gi;

const RULES: readonly (readonly [RegExp, string])[] = [
  // PEM blocks: private keys and certificates with their keys.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // Credentials in URLs: postgres://user:secret@host, https://user:secret@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, `$1:${REDACTED}@`],
  // HTTP authorisation schemes.
  [/\b(Bearer|Basic|Digest)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, REDACTED],
  // Secret fields, whatever their value looks like.
  [SECRET_FIELD, `$1"${REDACTED}"`],
  // Long random-looking strings: keys, credentials, hashes (40+ base64/base64url/hex characters).
  // A run that starts with "/" is a file path (Windows paths use "\\" and never form one run).
  [/(?<![A-Za-z0-9+/_-])(?!\/)[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_-])/g, REDACTED],
  // Personal data: email addresses and Indian phone numbers.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/(?<![\d.])(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?![\d.])/g, '[phone]'],
];

/** The text with secrets and personal data replaced. */
export function scrubText(text: string): string {
  let scrubbed = text;
  for (const [pattern, replacement] of RULES) scrubbed = scrubbed.replace(pattern, replacement);
  return scrubbed;
}

/**
 * A JSON-like value with every string scrubbed and the text or number under a secret-named key
 * removed, to any depth (arrays and objects are copied, never changed in place).
 */
export function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        // A secret-named string or number goes; a flag such as `credential: true` says nothing.
        SECRET_KEY.test(key) && (typeof inner === 'string' || typeof inner === 'number')
          ? REDACTED
          : scrubValue(inner),
      ]),
    );
  }
  return value;
}

const SECRET_KEY =
  /^(?:password|passwd|pass|pwd|secret|.*token|api_?key|apikey|private_?key|pin|pin_?hash|otp|credential|.*credentials|authorization|cookie|dsn|signature|.*secret)$/i;
