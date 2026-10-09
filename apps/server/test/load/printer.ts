import { createServer, type Server, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';

/** A page as it came out: when the last byte arrived, and its text. */
export interface PrintedJob {
  readonly at: number;
  readonly text: string;
  /** "KOT 12" and "Order 34" on a kitchen ticket. */
  readonly kotNumber: number | null;
  readonly orderNumber: number | null;
  /** "No: INV/25-26/000012" on a bill. */
  readonly invoiceNumber: string | null;
}

/** What a page says it is, from its printed text. */
export function readJob(text: string): Omit<PrintedJob, 'at' | 'text'> {
  const kot = /KOT (\d+)/.exec(text);
  const order = /Order (\d+)/.exec(text);
  const invoice = /No: (\S+)/.exec(text);
  return {
    kotNumber: kot === null ? null : Number(kot[1]),
    orderNumber: order === null ? null : Number(order[1]),
    invoiceNumber: invoice?.[1] ?? null,
  };
}

/**
 * A network printer (P8-01a): it takes raw ESC/POS on a TCP port, as almost every thermal printer
 * does on 9100, and keeps each job with the time it ended. The server sends a job on a connection
 * of its own and closes it, so a job is everything one connection carried.
 */
export class SimulatedPrinter {
  readonly jobs: PrintedJob[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly server: Server;

  private constructor(readonly name: string) {
    this.server = createServer((socket) => {
      this.take(socket);
    });
  }

  static async start(name: string): Promise<SimulatedPrinter> {
    const printer = new SimulatedPrinter(name);
    await new Promise<void>((resolve, reject) => {
      printer.server.once('error', reject);
      printer.server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    return printer;
  }

  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('The printer is off');
    return address.port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  private take(socket: Socket): void {
    this.sockets.add(socket);
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (chunks.length === 0) return;
      const text = Buffer.concat(chunks).toString('latin1');
      this.jobs.push({ at: performance.now(), text, ...readJob(text) });
    });
  }
}
