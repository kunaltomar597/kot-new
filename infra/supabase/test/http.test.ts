import { randomBytes, randomUUID } from 'node:crypto';
import type { ApiError } from '@rp/contracts/relay';
import {
  BROWSER_ID_HEADER,
  QrServiceRequestBody,
  QrSubmitOrderRequest,
  TABLE_TOKEN_HEADER,
} from '@rp/contracts/relay';
import { describe, expect, it } from 'vitest';
import {
  DINER_BODY_MAX_BYTES,
  type FunctionContext,
  MAX_BODY_BYTES,
  readBody,
} from '../src/http.js';
import { server } from '../src/server.js';
import { serviceRequest } from '../src/service-request.js';
import { submitOrder } from '../src/submit-order.js';

/**
 * How the functions read bodies (RELAY-D3) and whom they answer from a browser (RELAY-I5). None of
 * these calls gets as far as the database, which the context here refuses.
 */

const context: FunctionContext = {
  db: {
    transaction: () => Promise.reject(new Error('The database is not reached in these tests')),
  },
  now: () => new Date(),
  allowedOrigins: ['*'],
};

/** A body of `total` bytes in chunks of 64 KB, counting what the reader took. */
function streamed(total: number) {
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  let pulled = 0;
  // No queue of its own: a chunk is made only when the reader asks for one.
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled >= total) {
          controller.close();
          return;
        }
        pulled += chunk.length;
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  return {
    body,
    get pulled() {
      return pulled;
    },
  };
}

function request(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: ReadableStream<Uint8Array> },
): Request {
  return new Request(`https://relay.example.invalid/functions/v1/${path}`, {
    method: init.method ?? 'POST',
    headers: init.headers,
    // A stream is sent as it comes (`duplex: 'half'`), as a slow or chunked sender would.
    ...(init.body !== undefined && { body: init.body, duplex: 'half' }),
  });
}

const withoutToken = {
  'content-type': 'application/json',
  [BROWSER_ID_HEADER]: 'browser-body-limits',
};
const dinerHeaders = {
  ...withoutToken,
  [TABLE_TOKEN_HEADER]: randomBytes(16).toString('base64url'),
};

const codeOf = async (response: Response) => ((await response.json()) as ApiError).code;

describe('[RELAY-D3] [SEC-004] bodies are read with a cap', () => {
  it('refuses a body by its announced length before reading any of it', async () => {
    const sender = streamed(DINER_BODY_MAX_BYTES * 2);
    const response = await submitOrder(
      request('submit-order', {
        headers: { ...dinerHeaders, 'content-length': String(DINER_BODY_MAX_BYTES + 1) },
        body: sender.body,
      }),
      context,
    );
    expect(response.status).toBe(413);
    expect(await codeOf(response)).toBe('PAYLOAD_TOO_LARGE');
    expect(sender.pulled).toBe(0);
  });

  it('stops reading a body sent without a length as soon as it passes the cap', async () => {
    for (const [handler, path] of [
      [submitOrder, 'submit-order'],
      [serviceRequest, 'service-request'],
    ] as const) {
      const sender = streamed(MAX_BODY_BYTES);
      const response = await handler(
        request(path, { headers: dinerHeaders, body: sender.body }),
        context,
      );
      expect(response.status, path).toBe(413);
      // The stream may run a chunk or two ahead of the reader.
      expect(sender.pulled, path).toBeLessThanOrEqual(DINER_BODY_MAX_BYTES + 3 * 64 * 1024);
    }
    const sender = streamed(MAX_BODY_BYTES * 2);
    await expect(
      readBody(request('server/menu', { body: sender.body }), QrServiceRequestBody),
    ).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
    expect(sender.pulled).toBeLessThanOrEqual(MAX_BODY_BYTES + 3 * 64 * 1024);
  });

  it('reads no body of a diner’s call without a table code, or a PC’s without a credential', async () => {
    const order = streamed(1024);
    const noToken = await submitOrder(
      request('submit-order', { headers: withoutToken, body: order.body }),
      context,
    );
    expect(noToken.status).toBe(400);
    expect(order.pulled).toBe(0);
    const ask = streamed(1024);
    const noTokenRequest = await serviceRequest(
      request('service-request', { headers: withoutToken, body: ask.body }),
      context,
    );
    expect(noTokenRequest.status).toBe(400);
    expect(ask.pulled).toBe(0);

    for (const authorization of [undefined, 'Bearer short', `Basic ${'a'.repeat(43)}`]) {
      const menu = streamed(1024);
      const response = await server(
        request('server/menu', {
          method: 'PUT',
          headers: authorization === undefined ? {} : { authorization },
          body: menu.body,
        }),
        context,
      );
      expect(response.status, authorization).toBe(401);
      expect(await codeOf(response)).toBe('CREDENTIAL_REJECTED');
      expect(menu.pulled, authorization).toBe(0);
    }
  });

  it('fits the largest order a diner could send under the diners’ cap', () => {
    // 100 lines, each with a size, five option groups of four, a five-part combo, a suggestion and
    // the longest note allowed, in Devanagari (three bytes a letter).
    const note = 'क'.repeat(500);
    const order = QrSubmitOrderRequest.parse({
      idempotencyKey: randomUUID(),
      lines: Array.from({ length: 100 }, () => ({
        clientLineId: randomUUID(),
        itemId: randomUUID(),
        quantity: 99,
        variantId: randomUUID(),
        modifiers: Array.from({ length: 5 }, () => ({
          groupId: randomUUID(),
          optionIds: Array.from({ length: 4 }, () => randomUUID()),
        })),
        comboChoices: Array.from({ length: 5 }, () => randomUUID()),
        instructions: note,
        recommendation: { layer: 'RULE', ruleId: randomUUID() },
      })),
      orderNote: note,
      customerName: 'क'.repeat(60),
    });
    const bytes = new TextEncoder().encode(JSON.stringify(order)).length;
    expect(bytes).toBeLessThan(DINER_BODY_MAX_BYTES * 0.75);
  });
});

describe('[RELAY-I5] the PCs’ function answers no browser', () => {
  const credential = `Bearer ${randomBytes(32).toString('base64url')}`;
  const site = 'https://menu.example.in';

  it('sends no CORS headers, even to the QR site, and takes no preflight', async () => {
    const preflight = await server(
      request('server/presence', {
        method: 'OPTIONS',
        headers: {
          origin: site,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization',
        },
      }),
      context,
    );
    expect(preflight.status).toBe(405);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    expect(preflight.headers.get('access-control-allow-headers')).toBeNull();

    const refused = await server(
      request('server/orders', { method: 'GET', headers: { origin: site } }),
      context,
    );
    expect(refused.status).toBe(401);
    expect(refused.headers.get('access-control-allow-origin')).toBeNull();
    const unknown = await server(
      request('server/nothing', {
        method: 'GET',
        headers: { origin: site, authorization: credential },
      }),
      context,
    );
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('still answers the QR site from the diners’ functions', async () => {
    const preflight = await submitOrder(
      request('submit-order', { method: 'OPTIONS', headers: { origin: site } }),
      context,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(site);
  });
});
