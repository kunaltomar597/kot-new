import type { Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  ConnectionGate,
  isLoopback,
  KeyedBuckets,
  type Rate,
  ThrottledLog,
} from '../common/flood-limits.js';
import { AppError } from '../errors/app-error.js';
import { mapError } from '../errors/error-mapping.js';

/**
 * The HTTPS server's defences against floods from the LAN (PC-D3, P8-03c2a): a host on the staff
 * network must not be able to hold the server's connections, keep it busy with handshakes or
 * requests, or keep connections open by sending nothing. Not BRD ⚙ values: they protect the POS
 * server and sit far above what a restaurant's devices need (design capacity: a tablet on each of
 * 30 tables, 15 phones, 4 kitchen screens, 2 POS). The socket's limits per device are in
 * `RealtimeOptions`; the pager broker's in `PagerBrokerLimits`.
 */
export interface ServerLimits {
  /** The TLS handshake must finish within this time of the connection. */
  readonly handshakeMs: number;
  /** A request's headers must arrive within this time (slow headers, "Slowloris"). */
  readonly headersMs: number;
  /** A whole request, body included: a 55 MB AI menu import over slow Wi-Fi still fits. */
  readonly requestMs: number;
  /** How often the two times above are checked (HTTPS only: Node takes it at creation). */
  readonly checkEveryMs: number;
  /** A connection idle between requests is closed after this. */
  readonly keepAliveMs: number;
  /** Connections open at once, in all. */
  readonly maxConnections: number;
  /** Connections open at once from one address. */
  readonly maxConnectionsPerAddress: number;
  /** New connections from one address; beyond, they are closed before their TLS handshake. */
  readonly connectionsPerAddress: Rate;
  /** Requests from one address; beyond, 429 and the connection closed. */
  readonly requestsPerAddress: Rate;
  /** The PC's own addresses (the POS window, the set-up checks, the load test) are not limited. */
  readonly trustLoopback: boolean;
}

export const DEFAULT_SERVER_LIMITS: ServerLimits = {
  handshakeMs: 10_000,
  headersMs: 10_000,
  requestMs: 300_000,
  checkEveryMs: 1_000,
  keepAliveMs: 5_000,
  maxConnections: 4_096,
  // A Wi-Fi access point that translates addresses puts every phone and tablet behind one.
  maxConnectionsPerAddress: 256,
  connectionsPerAddress: { burst: 120, perSecond: 20 },
  requestsPerAddress: { burst: 400, perSecond: 100 },
  trustLoopback: true,
};

/** The options Node takes only when it creates the HTTPS server. */
export function httpsLimitOptions(limits: ServerLimits): {
  handshakeTimeout: number;
  connectionsCheckingInterval: number;
} {
  return { handshakeTimeout: limits.handshakeMs, connectionsCheckingInterval: limits.checkEveryMs };
}

type Refusal = 'too-many-connections' | 'connecting-too-fast' | 'requests-too-fast';

const REFUSALS: Readonly<Record<Refusal, string>> = {
  'too-many-connections': 'Refused connections over the limit for one address or in all',
  'connecting-too-fast': 'Refused connections from an address opening them too fast',
  'requests-too-fast': 'Refused requests from an address sending them too fast',
};

/** Refusals are logged once a minute per kind and address, with their count. */
const LOG_PERIOD_MS = 60_000;

export type RefusalWriter = (
  message: string,
  fields: { reason: Refusal; address: string; count: number },
) => void;

/**
 * Applies the limits to the server and returns the middleware that limits requests; it must run
 * before anything that reads or parses the request (`configureApp`).
 */
export function limitFloods(
  server: HttpServer,
  limits: ServerLimits,
  write: RefusalWriter,
  now: () => number = () => performance.now(),
): RequestHandler {
  const refusals = new ThrottledLog(
    LOG_PERIOD_MS,
    (key, count) => {
      const [reason, address] = key.split('|') as [Refusal, string];
      write(REFUSALS[reason], { reason, address, count });
    },
    now,
  );
  const refused = (reason: Refusal, address: string) => {
    refusals.note(`${reason}|${address}`);
  };
  const trusted = (address: string) => limits.trustLoopback && isLoopback(address);

  // Node's own timers: the handshake's is set at creation (`httpsLimitOptions`).
  server.headersTimeout = limits.headersMs;
  server.requestTimeout = limits.requestMs;
  server.keepAliveTimeout = limits.keepAliveMs;

  // Every TCP connection is counted first, before its TLS handshake costs anything. An HTTPS
  // connection never signs in (each request proves its device), so it counts while it is open.
  const gate = new ConnectionGate({
    maxConnections: limits.maxConnections,
    maxPending: limits.maxConnections,
    maxPendingPerAddress: limits.maxConnectionsPerAddress,
    trustLoopback: limits.trustLoopback,
  });
  const opening = new KeyedBuckets(limits.connectionsPerAddress);
  server.prependListener('connection', (socket: Socket) => {
    const address = socket.remoteAddress ?? 'unknown';
    if (!trusted(address) && !opening.take(address, now())) {
      refused('connecting-too-fast', address);
      socket.destroy();
      return;
    }
    const ticket = gate.admit(address);
    if (ticket === undefined) {
      refused('too-many-connections', address);
      socket.destroy();
      return;
    }
    socket.once('close', () => {
      ticket.closed();
    });
  });

  const requests = new KeyedBuckets(limits.requestsPerAddress);
  return (request: Request, response: Response, next: NextFunction) => {
    const address = request.socket.remoteAddress ?? 'unknown';
    if (trusted(address) || requests.take(address, now())) {
      next();
      return;
    }
    refused('requests-too-fast', address);
    // Closing the connection makes a flooding host open a new one, which the gate limits too.
    response.setHeader('connection', 'close');
    response.setHeader('retry-after', '1');
    const id = (request as Request & { id?: unknown }).id;
    const mapped = mapError(
      new AppError(
        429,
        'RATE_LIMITED',
        'Too many requests from this device. Wait a moment and try again.',
      ),
      typeof id === 'string' ? id : undefined,
    );
    response.status(mapped.status).json(mapped.body);
  };
}
