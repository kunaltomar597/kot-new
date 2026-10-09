import { Agent, request } from 'node:https';

/**
 * `fetch` over HTTPS that trusts only the restaurant's CA, as a paired device that pinned it
 * does (P0-15). Each simulated device gets its own, with its own kept-alive connections, like a
 * phone or a browser. Node's global `fetch` cannot be given a CA without undici's `Agent`.
 */
export function tlsFetch(ca: string): typeof fetch {
  const agent = new Agent({ ca, keepAlive: true, maxSockets: 6 });
  const send = (url: URL, init: RequestInit | undefined, again: boolean): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const headers = new Headers(init?.headers);
      const outgoing = request(
        url,
        {
          agent,
          method: init?.method ?? 'GET',
          headers: Object.fromEntries(headers.entries()),
          signal: init?.signal ?? undefined,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () => {
            const status = response.statusCode ?? 500;
            const answer = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (value === undefined) continue;
              for (const each of Array.isArray(value) ? value : [value]) answer.append(name, each);
            }
            const body = status === 204 || status === 304 ? null : Buffer.concat(chunks);
            resolve(
              new Response(body, { status, statusText: response.statusMessage, headers: answer }),
            );
          });
        },
      );
      outgoing.on('error', (error: NodeJS.ErrnoException) => {
        // The server closed a kept-alive connection as it was reused (its 5 s idle timeout):
        // nothing reached it, so send once more on a new one, as browsers and OkHttp do.
        if (again && outgoing.reusedSocket && error.code === 'ECONNRESET') {
          send(url, init, false).then(resolve, reject);
        } else reject(error);
      });
      const body = init?.body;
      if (body === undefined || body === null) outgoing.end();
      else if (typeof body === 'string' || body instanceof Uint8Array) outgoing.end(body);
      else {
        outgoing.destroy();
        reject(new Error('tlsFetch sends only text or bytes'));
      }
    });
  return (input, init) =>
    send(new URL(input instanceof Request ? input.url : String(input)), init, true);
}
