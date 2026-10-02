/** Where reports go: the envelope endpoint and the project's public key (not a secret). */
export interface SentryDsn {
  readonly endpoint: string;
  readonly publicKey: string;
  readonly projectId: string;
}

/** Reads `https://<public key>@<host>/<project id>`; throws on anything else. */
export function parseDsn(dsn: string): SentryDsn {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error('The error reporting DSN is not a valid address');
  }
  const projectId = url.pathname.split('/').filter(Boolean).at(-1);
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username === '' ||
    projectId === undefined ||
    !/^\d+$/.test(projectId)
  ) {
    throw new Error('The error reporting DSN must look like https://key@host/123');
  }
  const prefix = url.pathname.split('/').filter(Boolean).slice(0, -1).join('/');
  return {
    endpoint: `${url.protocol}//${url.host}/${prefix === '' ? '' : `${prefix}/`}api/${projectId}/envelope/`,
    publicKey: url.username,
    projectId,
  };
}
