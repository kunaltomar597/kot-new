import { SPLASH_CSP } from './security.js';

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/** The page shown while the server starts, as a `data:` URL: no file, no script. */
export function splashUrl(title: string, message: string): string {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${SPLASH_CSP}">
<title>${escapeHtml(title)}</title>
<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#f4f4f2;color:#1b1b1b;font:18px system-ui,sans-serif}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}</style>
</head><body><main><h1 style="font-size:1.4rem">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
