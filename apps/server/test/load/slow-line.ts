import { createConnection, createServer, type Server, type Socket } from 'node:net';

/**
 * An internet line for the load run (P8-01b): a TCP relay to `target` that delivers every chunk,
 * each way, `oneWayMs` after it was sent, in order, as a line with that latency does. HTTP and the
 * Realtime WebSocket both go through it. Bandwidth is not limited: the run's messages are small.
 */
export interface SlowLine {
  /** Where to connect instead of the target. */
  readonly port: number;
  readonly oneWayMs: number;
  stop(): Promise<void>;
}

export async function startSlowLine(
  target: { readonly host: string; readonly port: number },
  oneWayMs: number,
): Promise<SlowLine> {
  const sockets = new Set<Socket>();
  const later = (work: () => void) => {
    // Timers of the same delay run in the order they were set, so chunks keep their order.
    setTimeout(work, oneWayMs);
  };
  /** Copies `from` to `to`, late; ends `to` once everything before the end has arrived. */
  const pipe = (from: Socket, to: Socket) => {
    from.on('data', (chunk) => {
      later(() => {
        if (!to.destroyed) to.write(chunk);
      });
    });
    from.on('end', () => {
      later(() => {
        if (!to.destroyed) to.end();
      });
    });
    from.on('close', () => {
      later(() => {
        to.destroy();
      });
    });
    from.on('error', () => {
      from.destroy();
    });
  };
  const server: Server = createServer({ allowHalfOpen: true }, (near) => {
    const far = createConnection({ host: target.host, port: target.port, allowHalfOpen: true });
    for (const socket of [near, far]) {
      sockets.add(socket);
      socket.setNoDelay(true);
      socket.on('close', () => sockets.delete(socket));
    }
    pipe(near, far);
    pipe(far, near);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    oneWayMs,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}
