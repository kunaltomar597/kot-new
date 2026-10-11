import { createHash } from 'node:crypto';

/**
 * The bill behind a digital bill's link (BILL-012, P7-09a): the bill as printed, on a page with no
 * scripts, nothing loaded from elsewhere and nothing for search engines.
 */

/** The page's only styles; the CSP allows exactly this text (P8-03c1), not inline styles in general. */
const STYLE = `
body{margin:0;padding:16px;background:#f4f4f2;color:#1b1b1b;font-family:system-ui,sans-serif}
main{max-width:420px;margin:0 auto;background:#fff;border-radius:8px;padding:16px}
h1{font-size:1.1rem;margin:0 0 12px}
pre{margin:0;overflow-x:auto;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre}
p{font-size:.85rem;color:#555;margin:16px 0 0}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}main{background:#1d1d1d}p{color:#aaa}}
@media print{body{background:#fff;padding:0}main{padding:0}p{display:none}}
`;

const STYLE_HASH = `'sha256-${createHash('sha256').update(STYLE, 'utf8').digest('base64')}'`;

/** Headers for every bill page: nothing runs, nothing is framed, cached or indexed. */
export const BILL_PAGE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': `default-src 'none'; style-src ${STYLE_HASH}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow',
};

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

export function billPage(bill: {
  readonly restaurantName: string;
  readonly invoiceNumber: string;
  readonly lines: readonly string[];
  /** `04-11-2026`. */
  readonly expiresOn: string;
}): string {
  return page(
    `${bill.restaurantName}: bill ${bill.invoiceNumber}`,
    `<h1>${escapeHtml(bill.restaurantName)}</h1>
<pre>${escapeHtml(bill.lines.join('\n'))}</pre>
<p>This copy of your bill is available until ${escapeHtml(bill.expiresOn)}. Save or print it to keep it.</p>`,
  );
}

export function goneBillPage(): string {
  return page(
    'Bill no longer available',
    `<h1>This bill is no longer available</h1>
<p>Its copy was kept for a limited time and has been deleted. Ask the restaurant for a copy.</p>`,
  );
}

export function unknownBillPage(): string {
  return page(
    'Bill not found',
    `<h1>This link does not open a bill</h1>
<p>Check that the whole link was copied.</p>`,
  );
}
